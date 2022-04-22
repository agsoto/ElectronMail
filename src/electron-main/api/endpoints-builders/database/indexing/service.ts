import {concatMap, filter, first} from "rxjs/operators";
import electronLog from "electron-log";
import {lastValueFrom, race, throwError, timer} from "rxjs";
import {pick} from "remeda";
import UUID from "pure-uuid";

import {Config} from "src/shared/model/options";
import {curryFunctionMembers} from "src/shared/util";
import {DbAccountPk, FsDbAccount, INDEXABLE_MAIL_FIELDS, Mail} from "src/shared/model/database";
import {hrtimeDuration} from "src/electron-main/util";
import {IPC_MAIN_API_DB_INDEXER_REQUEST$, IPC_MAIN_API_DB_INDEXER_RESPONSE$} from "src/electron-main/api/const";
import {IPC_MAIN_API_DB_INDEXER_REQUEST_ACTIONS, IPC_MAIN_API_DB_INDEXER_RESPONSE_ACTIONS} from "src/shared/api/main-process/actions";
import {ofType} from "src/shared/util/ngrx-of-type";
import {readMailBody} from "src/shared/util/entity";
import {UnionOf} from "src/shared/util/ngrx";

const logger = curryFunctionMembers(electronLog, __filename);

type narrowIndexActionPayloadType = (
    payload: StrictOmit<Extract<UnionOf<typeof IPC_MAIN_API_DB_INDEXER_REQUEST_ACTIONS>, { type: "Index" }>["payload"], "uid">,
) => typeof payload;

export const narrowIndexActionPayload: narrowIndexActionPayloadType = ((): narrowIndexActionPayloadType => {
    type Fn = narrowIndexActionPayloadType;
    type Mails = ReturnType<Fn>["add"];

    const fieldsToIndex = [
        ((name: keyof Pick<Unpacked<Mails>, "pk">): typeof name => name)("pk"),
        ...INDEXABLE_MAIL_FIELDS,
    ];

    const result: Fn = ({key, remove, add}) => {
        return {
            key,
            remove,
            add: add.map((mail) => {
                return {
                    ...pick(mail, fieldsToIndex),
                    [((prop: keyof Pick<typeof mail, "body">) => prop)("body")]: readMailBody(mail),
                };
            }),
        };
    };

    return result;
})();

async function indexMails(
    mails: Array<DeepReadonly<Mail>>,
    key: DeepReadonly<DbAccountPk>,
    timeoutMs: number,
): Promise<void> {
    logger.info(nameof(indexMails));

    const duration = hrtimeDuration();
    const uid = new UUID(4).format();
    const result$ = race(
        IPC_MAIN_API_DB_INDEXER_RESPONSE$.pipe(
            ofType(IPC_MAIN_API_DB_INDEXER_RESPONSE_ACTIONS.IndexingResult),
            filter(({payload}) => payload.uid === uid),
            first(),
        ),
        timer(timeoutMs).pipe(
            concatMap(() => throwError(new Error(`Failed index emails in ${timeoutMs}ms (mails portions size: ${mails.length})`))),
        ),
    );

    IPC_MAIN_API_DB_INDEXER_REQUEST$.next(
        IPC_MAIN_API_DB_INDEXER_REQUEST_ACTIONS.Index({
            uid,
            ...narrowIndexActionPayload({
                key,
                remove: [],
                add: mails,
            }),
        }),
    );

    return lastValueFrom(result$).then(() => {
        logger.verbose(nameof(indexMails), "end", {indexed: mails.length, duration: duration.end()});
    });
}

export async function indexAccount(
    account: DeepReadonly<FsDbAccount>,
    key: DeepReadonly<DbAccountPk>,
    config: DeepReadonly<Config>,
): Promise<void> {
    logger.info(nameof(indexAccount));

    const duration = hrtimeDuration();
    const buffer: Mail[] = [];

    for (const mail of Object.values(account.mails)) {
        buffer.push(mail);

        if (buffer.length < config.indexingBootstrapBufferSize) {
            continue;
        }

        await indexMails(buffer, key, config.timeouts.indexingBootstrap);
        buffer.length = 0;
    }

    if (buffer.length) {
        await indexMails(buffer, key, config.timeouts.indexingBootstrap);
    }

    logger.verbose(nameof(indexAccount), "end", {indexed: account.mails.size, duration: duration.end()});
}
