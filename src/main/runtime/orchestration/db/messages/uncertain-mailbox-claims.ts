import type { OrchestrationDb } from '../orchestration-db'
import { MAILBOX_POINTER_RESERVED } from './mailbox-pointer-enter-state'

/** Whether one mailbox still holds mail this PTY incarnation typed without confirmation.
 * Why per mailbox: a terminal-wide recount reads every Run's retained claims to answer for one. */
export function hasUncertainMailboxClaims(
  db: OrchestrationDb,
  claim: { ptyId: string; mailbox: string; incarnation: string; staged: ReadonlySet<string> }
): boolean {
  const rows = db.db
    .prepare(
      `SELECT id FROM messages INDEXED BY idx_messages_pending_pointer_enter
       WHERE to_handle = ? AND read = 0 AND pointer_enter_pending > 0
         AND pointer_enter_pending > ${MAILBOX_POINTER_RESERVED}
         AND pointer_pty_id = ? AND pointer_process_incarnation = ?
         AND delivery_contract = 'current_delivery'
       LIMIT ?`
    )
    .all(claim.mailbox, claim.ptyId, claim.incarnation, claim.staged.size + 1)
  return rows.some((row) => !claim.staged.has(String(row.id)))
}
