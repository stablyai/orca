import {
  USER_KEPT_WORKER_TERMINAL_SQL,
  type WorkerTerminalRetainedReason
} from '../../terminal-authority/release/worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import { bumpWorkerTerminalReleaseAttempt } from './worker-terminal-release-attempt'

/** Caller owns the transaction; retain must preserve committed release state and its output reference. */
export function retainTerminalResourceInTransaction(
  database: OrchestrationDb,
  resourceId: string,
  dispatchId: string,
  retainableSql = "release_state IN ('not_requested', 'retained', 'requested')",
  reason: Extract<WorkerTerminalRetainedReason, 'user_requested' | 'user_kept'> = 'user_requested'
): boolean {
  const { changes } = database.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET retained_reason = CASE WHEN ${USER_KEPT_WORKER_TERMINAL_SQL} THEN retained_reason ELSE ? END,
           release_state = 'retained', auto_release_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND ${retainableSql}`
    )
    .run(reason, resourceId)
  if (changes > 0) {
    // A release whose exit proof was awaiting sees this keep-open even when it rewrote the same state.
    bumpWorkerTerminalReleaseAttempt(database, resourceId)
    // A stopped worker's terminal is closed; the reference taken before stop is its only pointer to output.
    const dropped = database.db
      .prepare(
        `DELETE FROM worker_terminal_archives WHERE dispatch_id = ? AND NOT EXISTS (
           SELECT 1 FROM worker_dispatches WHERE dispatch_id = ? AND state = 'stopped')`
      )
      .run(dispatchId, dispatchId)
    if (dropped.changes > 0) {
      database.db
        .prepare(
          'UPDATE worker_terminal_resources SET archive_source = NULL, archive_status = NULL WHERE id = ?'
        )
        .run(resourceId)
    }
  }
  return changes > 0
}
