// Startup recovery for execution runs interrupted by a crash or restart
// (Phase 4). The spawned Claude process is a child of the Electron main process,
// so a restart means it is gone: a `running` row cannot be assumed alive.
//
// PIDs are deliberately NOT used for liveness. PID reuse makes "is it alive"
// unanswerable across a restart, and a wrong answer is worse than an honest
// `interrupted`. Recovery never fabricates an outcome — it records exactly "we
// do not know how this ended".
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import { getTaskRow } from './audited-execution-run-repository'

export type RecoveredInterruptedExecutionRun = { taskId: string; runId: string }

// The generic block code per active run state. Both already exist in
// BLOCK_REASON_CODES; Phase 4 adds no reason vocabulary to audited_tasks.
function blockCodeForState(state: AuditedTaskState): string {
  return state === 'planning' ? 'plan_process_failed' : 'implement_process_failed'
}

/**
 * Marks every `running` execution row `interrupted` and blocks its task with
 * pre_block_state set, so Retry is legal. One transaction per row, idempotent
 * and CAS-guarded: a second pass finds nothing left to do.
 */
export function recoverInterruptedExecutionRuns(
  db: Database.Database,
  nowMs: number
): RecoveredInterruptedExecutionRun[] {
  const running = db
    .prepare(
      `SELECT id, task_id, active_run_state FROM audited_execution_runs WHERE status = 'running'`
    )
    .all() as { id: string; task_id: string; active_run_state: string }[]

  const recovered: RecoveredInterruptedExecutionRun[] = []
  for (const run of running) {
    if (recoverOneRun(db, run.id, run.task_id, run.active_run_state as AuditedTaskState, nowMs)) {
      recovered.push({ taskId: run.task_id, runId: run.id })
    }
  }
  return recovered
}

function recoverOneRun(
  db: Database.Database,
  runId: string,
  taskId: string,
  activeRunState: AuditedTaskState,
  nowMs: number
): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = getTaskRow(db, taskId)
    // A task that already moved on has had this interruption handled (or the
    // row is stale bookkeeping). Skip without writing, so repeated passes are
    // idempotent.
    if (!task || task.state !== activeRunState) {
      db.exec('ROLLBACK')
      return false
    }

    const runUpdate = db
      .prepare(
        `UPDATE audited_execution_runs
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
            SET state = 'blocked', pre_block_state = ?, blocked_reason_code = ?,
                blocked_phase = 'execution', updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(activeRunState, blockCodeForState(activeRunState), nowMs, taskId, activeRunState)
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return false
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, 'blocked', 'control', 'execution_interrupted', 'interrupted', NULL, ?)`
    ).run(taskId, activeRunState, nowMs)

    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
