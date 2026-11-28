import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import { readMessageSenderDispatch } from '../../../../orchestration/db/messages/message-sender-dispatch'
import type { SendRecipientWarning } from './recipient-routing'

/** Warns, without blocking, when the sender wrote again after the message being answered and the
 *  replier has not answered that newer mail yet. Newer mail counts on the same thread, or anywhere
 *  between a worker and its coordinator on one Dispatch, since all of that pair's mail is one task;
 *  other pairs, such as two bots, carry unrelated topics and stay thread-scoped. */
export function supersededReplyWarning(
  db: OrchestrationDb,
  original: Pick<MessageRow, 'id' | 'from_handle' | 'to_handle' | 'sequence' | 'thread_id'>
): SendRecipientWarning | undefined {
  const toWorkerMailbox = original.to_handle.startsWith('dispatch:')
  const workerDispatchId = toWorkerMailbox
    ? null
    : (readMessageSenderDispatch(db, original.id)?.dispatchId ?? null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects these columns.
  const newer = db.db
    .prepare(
      `SELECT newer.id, COALESCE(newer.thread_id, newer.id) = ?4 AS same_thread,
         (SELECT COUNT(*) FROM messages later
          WHERE later.to_handle = newer.to_handle AND later.sequence >= newer.sequence) AS rows_since
       FROM messages newer
       WHERE newer.to_handle = ?1 AND newer.from_handle = ?2 AND newer.sequence > ?3
         AND newer.type <> 'heartbeat'
         AND (
           COALESCE(newer.thread_id, newer.id) = ?4
           OR ?5 = 1
           OR EXISTS (
             SELECT 1 FROM message_dispatch_provenance provenance
             WHERE provenance.message_id = newer.id AND provenance.dispatch_id = ?6
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages answer
           WHERE answer.thread_id = COALESCE(newer.thread_id, newer.id) AND answer.reply_to = newer.id
         )
       ORDER BY newer.sequence DESC LIMIT 1`
    )
    .get(
      original.to_handle,
      original.from_handle,
      original.sequence,
      original.thread_id ?? original.id,
      toWorkerMailbox ? 1 : 0,
      workerDispatchId
    ) as { id: string; same_thread: number; rows_since: number } | undefined
  if (!newer) {
    return undefined
  }
  const where = newer.same_thread ? 'on this thread' : 'on this task'
  return {
    code: 'superseded_reply',
    recipient: original.from_handle,
    message: `${newer.id} from ${original.from_handle} ${where} is newer than the message you answered; read it with \`orca orchestration inbox --terminal ${original.to_handle} --limit ${newer.rows_since} --full\`, and send a correction if your reply no longer fits.`
  }
}
