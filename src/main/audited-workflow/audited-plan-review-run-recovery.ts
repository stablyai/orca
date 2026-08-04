// Startup recovery for plan-review runs interrupted by a crash or restart
// (Phase 5). The spawned Codex process is a child of the Electron main process,
// so a restart means it is gone: a `running` row cannot be assumed alive.
//
// PIDs are deliberately NOT used for liveness — PID reuse makes "is it alive"
// unanswerable across a restart, and a wrong answer is worse than an honest
// `interrupted`. Recovery never fabricates a verdict; it records exactly "we do
// not know how this ended".
import type Database from '../sqlite/sync-database'

export type RecoveredPlanReviewRun = { taskId: string; runId: string }

/**
 * Marks every `running` review row `interrupted` and blocks its task with
 * pre_block_state set, so Retry Audit is legal. One transaction per row,
 * idempotent and CAS-guarded: a second pass finds nothing left to do.
 */
export function recoverInterruptedPlanReviewRuns(
  db: Database.Database,
  nowMs: number
): RecoveredPlanReviewRun[] {
  const running = db
    .prepare(`SELECT id, task_id FROM audited_plan_review_runs WHERE status = 'running'`)
    .all() as { id: string; task_id: string }[]

  const recovered: RecoveredPlanReviewRun[] = []
  for (const run of running) {
    if (recoverOneRun(db, run.id, run.task_id, nowMs)) {
      recovered.push({ taskId: run.task_id, runId: run.id })
    }
  }
  return recovered
}

function recoverOneRun(
  db: Database.Database,
  runId: string,
  taskId: string,
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db.prepare(`SELECT state FROM audited_tasks WHERE id = ?`).get(taskId) as
      | { state: string }
      | undefined
    // A task that already moved on has had this interruption handled (or the row
    // is stale bookkeeping). Skip without writing, so repeated passes are
    // idempotent.
    if (!task || task.state !== 'awaiting_plan_review') {
      db.exec('ROLLBACK')
      return false
    }

    const runUpdate = db
      .prepare(
        `UPDATE audited_plan_review_runs
            SET status = 'interrupted', reason_code = 'interrupted', ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(nowMs, runId, taskId)
    if (runUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = 'awaiting_plan_review',
                blocked_reason_code = 'plan_review_process_failed',
                blocked_phase = 'planReview', updated_at_ms = ?
          WHERE id = ? AND state = 'awaiting_plan_review'`
      )
      .run(nowMs, taskId)
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_plan_review', 'blocked', 'control',
               'plan_review_interrupted', 'interrupted', NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
