// Per-draft holds: what keeps one card from auto-sending, stored on its row. A
// Stop or a restart pauses the queue instead (`queued-message-pause.ts`, derived);
// a per-draft hold is a conversion that failed, or a send the host kept
// (`QueuedMessageHoldReason`), which an explicit Send releases.

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

/** Ends a restart's pause: waiting rows another host instance wrote are adopted
 *  into this one, the same fact the pause is derived from, so no second copy
 *  exists. Also clears a per-row 'stopped' hold an earlier build of the queue
 *  wrote, which this build only ever lifts. Returns how many rows it changed. */
export function adoptQueuedMessages(
  db: Database.Database,
  input: { sessionId: string; hostInstance: string }
): number {
  return Number(
    db
      .prepare(
        `UPDATE queued_messages
         SET host_instance = ?, hold_reason = CASE WHEN hold_reason = 'stopped' THEN NULL ELSE hold_reason END
         WHERE session_id = ? AND state = 'waiting'
           AND (host_instance <> ? OR hold_reason = 'stopped')`
      )
      .run(input.hostInstance, input.sessionId, input.hostInstance).changes ?? 0
  )
}
