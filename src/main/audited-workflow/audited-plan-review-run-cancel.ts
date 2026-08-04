// Human cancellation of a running Codex plan review (Phase 5).
//
// Unlike a cancelled EXECUTION run, there is no state to restore: the task rests
// in awaiting_plan_review for the whole review, so cancelling leaves it exactly
// where it was and writes no task row at all. The review row alone becomes
// terminal.
//
// Cancel runs NO Git command whatsoever. Nothing Codex read is undone, because
// a read-only review changed nothing to undo.
import type Database from '../sqlite/sync-database'
import { getPlanReviewRun } from './audited-plan-review-run-repository'

export type CancelPlanReviewResult = { ok: true } | { ok: false; reasonCode: 'lock_contended' }

/**
 * Finalizes the run as `cancelled`.
 *
 * MUST be called only after the process tree has already been killed. Ordering
 * is load-bearing: committing while the process still runs would leave a live
 * process with no `running` row — unkillable and invisible to startup recovery.
 */
export function cancelPlanReviewRun(
  db: Database.Database,
  args: { runId: string; taskId: string },
  nowMs: number
): CancelPlanReviewResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const run = getPlanReviewRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const updated = db
      .prepare(
        `UPDATE audited_plan_review_runs
            SET status = 'cancelled', reason_code = 'cancelled_by_user', ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(nowMs, args.runId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // The human action is real history even though no state changed, so it is
    // recorded with equal from/to — matching cancelExecutionRun's plan-mode row.
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_plan_review', 'awaiting_plan_review', 'human',
               'plan_review_cancelled', 'cancelled_by_user', NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
