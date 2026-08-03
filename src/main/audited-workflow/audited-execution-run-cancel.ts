// Human cancellation of a running execution (Phase 4 §1).
//
// The restore target is the run's recorded pre_launch_state, never inferred from
// the mode: `planning` for plan, `ready_to_implement` for direct. Restoring a
// direct run to `implementing` would strand it — startExecution admits only
// `ready_to_implement`, so Start would be refused forever.
//
// The direct restore goes through the state machine's `cancelImplementation`
// rule. There is deliberately NO direct-SQL state write that skips that check:
// bypassing the state machine here would be a permanent hole in its authority.
//
// Cancel runs NO Git command whatsoever — no stage, revert, clean, reset, or
// commit. Files Claude already wrote stay on disk; the next verification reports
// drift honestly rather than silently "cleaning up".
import type Database from '../sqlite/sync-database'
import { getExecutionRun, getTaskRow } from './audited-execution-run-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type CancelExecutionRunResult =
  | { ok: true; restoredState: string }
  | { ok: false; reasonCode: 'task_not_found' | 'illegal_transition' | 'lock_contended' }

/**
 * Finalizes the run as `cancelled` AND restores the task's pre-launch state in
 * ONE transaction.
 *
 * MUST be called only after the process tree has already been killed. Ordering
 * is load-bearing: committing while the process still runs would leave a live
 * process with no `running` row — unkillable and invisible to startup recovery.
 */
export function cancelExecutionRun(
  db: Database.Database,
  args: { runId: string; taskId: string },
  nowMs: number
): CancelExecutionRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = getTaskRow(db, args.taskId)
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    const run = getExecutionRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }
    // The task must still be where this run lives; otherwise something else
    // already moved it and this cancel is not the authorized writer.
    if (task.state !== run.activeRunState) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const restoresState = run.preLaunchState !== run.activeRunState
    if (restoresState) {
      // Direct mode only. Validate BEFORE any task write — this is the check the
      // acceptance criterion forbids bypassing.
      const validation = validateAuditedTransition('cancelImplementation', run.activeRunState)
      if (!validation.ok || validation.rule.to !== run.preLaunchState) {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'illegal_transition' }
      }
    }

    const runUpdate = db
      .prepare(
        `UPDATE audited_execution_runs
            SET status = 'cancelled', reason_code = 'cancelled_by_user', ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(nowMs, args.runId, args.taskId)
    if (runUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    if (restoresState) {
      const taskUpdate = db
        .prepare(`UPDATE audited_tasks SET state = ?, updated_at_ms = ? WHERE id = ? AND state = ?`)
        .run(run.preLaunchState, nowMs, args.taskId, run.activeRunState)
      if (taskUpdate.changes !== 1) {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'lock_contended' }
      }
    }

    // Written for BOTH modes. For plan the from/to states are equal, but the
    // human action is real history and the row records it truthfully.
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, 'human', 'execution_cancelled', 'cancelled_by_user', NULL, ?)`
    ).run(args.taskId, run.activeRunState, run.preLaunchState, nowMs)

    db.exec('COMMIT')
    return { ok: true, restoredState: run.preLaunchState }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
