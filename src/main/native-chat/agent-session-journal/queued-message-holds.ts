// Per-draft holds: what keeps one card from auto-sending, stored on its row. A
// Stop, a /clear or a reopen pauses the queue instead (`queued-message-pause.ts`,
// derived); a per-draft hold is a conversion that failed (`QueuedMessageHoldReason`),
// which an explicit Send releases.

import type Database from '../../sqlite/sync-database'
import type { QueuedMessageHoldReason } from './queued-message-table'

/** Hold waiting drafts from auto-sending. The hold retires with the row: consume
 *  and withdraw clear it in their own UPDATE. Returns how many rows it newly reached. */
export function holdQueuedMessages(
  db: Database.Database,
  input: {
    sessionId: string
    messageIds: readonly string[]
    reason: QueuedMessageHoldReason
  }
): number {
  const update = db.prepare(
    `UPDATE queued_messages SET hold_reason = ?
     WHERE session_id = ? AND message_id = ? AND state = 'waiting'
       AND (hold_reason IS NULL OR hold_reason <> ?)`
  )
  let held = 0
  for (const messageId of input.messageIds) {
    held += Number(update.run(input.reason, input.sessionId, messageId, input.reason).changes ?? 0)
  }
  return held
}
