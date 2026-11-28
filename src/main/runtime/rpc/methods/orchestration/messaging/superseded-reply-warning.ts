import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { SendRecipientWarning } from './recipient-routing'

/** Warns, without blocking, when the sender wrote again on this thread after the message being
 *  answered, and the replier has not answered that newer mail yet. */
export function supersededReplyWarning(
  db: OrchestrationDb,
  original: Pick<MessageRow, 'id' | 'from_handle' | 'to_handle' | 'sequence' | 'thread_id'>
): SendRecipientWarning | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects these two columns.
  const newer = db.db
    .prepare(
      `SELECT newer.id,
         (SELECT COUNT(*) FROM messages later
          WHERE later.to_handle = newer.to_handle AND later.sequence >= newer.sequence) AS rows_since
       FROM messages newer
       WHERE newer.to_handle = ?1 AND newer.from_handle = ?2 AND newer.sequence > ?3
         AND newer.type <> 'heartbeat'
         AND COALESCE(newer.thread_id, newer.id) = ?4
         AND NOT EXISTS (
           SELECT 1 FROM messages answer
           WHERE answer.thread_id = ?4 AND answer.reply_to = newer.id
         )
       ORDER BY newer.sequence DESC LIMIT 1`
    )
    .get(
      original.to_handle,
      original.from_handle,
      original.sequence,
      original.thread_id ?? original.id
    ) as { id: string; rows_since: number } | undefined
  return newer
    ? {
        code: 'superseded_reply',
        recipient: original.from_handle,
        message: `${newer.id} from ${original.from_handle} on this thread is newer than the message you answered; read it with \`orca orchestration inbox --terminal ${original.to_handle} --limit ${newer.rows_since} --full\`, and send a correction if your reply no longer fits.`
      }
    : undefined
}
