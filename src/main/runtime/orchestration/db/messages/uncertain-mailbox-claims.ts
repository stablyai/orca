import type { OrchestrationDb } from '../orchestration-db'
import { MAILBOX_POINTER_RESERVED } from './mailbox-pointer-enter-state'

/** Whether one mailbox still holds mail this PTY incarnation typed without confirmation.
 * Why keyed by PTY, mailbox and incarnation: other terminals' claims in a shared Run mailbox stay out of range. */
export function hasUncertainMailboxClaims(
  db: OrchestrationDb,
  claim: { ptyId: string; mailbox: string; incarnation: string; staged: ReadonlySet<string> }
): boolean {
  const rows = db.db
    .prepare(
      `SELECT id FROM messages INDEXED BY idx_messages_uncertain_pointer_claims
       WHERE pointer_pty_id = ? AND to_handle = ? AND pointer_process_incarnation = ?
         AND read = 0 AND pointer_enter_pending > ${MAILBOX_POINTER_RESERVED}
         AND delivery_contract = 'current_delivery'
       LIMIT ?`
    )
    .all(claim.ptyId, claim.mailbox, claim.incarnation, claim.staged.size + 1)
  return rows.some((row) => !claim.staged.has(String(row.id)))
}
