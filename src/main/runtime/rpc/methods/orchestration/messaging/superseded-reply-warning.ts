import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { SendRecipientWarning } from './recipient-routing'

/** Warns, without blocking, when the sender wrote again after the message being answered. */
export function supersededReplyWarning(
  db: OrchestrationDb,
  original: Pick<MessageRow, 'from_handle' | 'to_handle' | 'sequence'>
): SendRecipientWarning | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects only id.
  const newer = db.db
    .prepare(
      `SELECT id FROM messages
       WHERE to_handle = ? AND from_handle = ? AND sequence > ? AND type <> 'heartbeat'
       ORDER BY sequence DESC LIMIT 1`
    )
    .get(original.to_handle, original.from_handle, original.sequence) as { id: string } | undefined
  return newer
    ? {
        code: 'superseded_reply',
        recipient: original.from_handle,
        message: `${newer.id} from ${original.from_handle} is newer than the message you answered; read it, and send a correction if your reply no longer fits.`
      }
    : undefined
}
