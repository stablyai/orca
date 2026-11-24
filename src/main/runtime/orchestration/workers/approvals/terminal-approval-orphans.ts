/** A terminal worker's prompt is answerable only while Orca holds its hook, and holds live in
 *  memory: after a restart, a prompt still open in the mailbox can no longer be answered here. */
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  TERMINAL_APPROVAL_ID_PREFIX,
  closeReportedApproval,
  recentOpenApprovalReports
} from './worker-approval-report'

/** Closes every open terminal-worker prompt, so its card becomes a receipt; a prompt already
 *  closed keeps its line, since the closing report's id is fixed per prompt. */
export function closeOrphanedTerminalApprovals(db: OrchestrationDb): void {
  try {
    sweep(db)
  } catch (error) {
    // Runs while the database opens; a failed sweep must not fail that.
    console.warn('[orchestration] closing orphaned terminal approvals failed', error)
  }
}

function sweep(db: OrchestrationDb): void {
  for (const { approval, dispatch } of recentOpenApprovalReports(db)) {
    if (approval.approvalId.startsWith(TERMINAL_APPROVAL_ID_PREFIX)) {
      closeReportedApproval(
        db,
        dispatch,
        approval.approvalId,
        { by: 'unknown', decision: null, reason: null, reasonDelivered: true },
        // Nothing to wake: the coordinator reads it with its next mail.
        { notify: () => {} }
      )
    }
  }
}
