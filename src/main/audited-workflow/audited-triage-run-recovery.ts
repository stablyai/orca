// Startup/init recovery for triage runs interrupted by a process crash or
// restart (Phase 2). A task can only be left `triaging` with a `running`
// audited_triage_runs row if the process died between startTriageRun's
// commit and finalizeTriageRun*'s commit — no other code path can produce
// that combination while the process is alive (finalize always runs inside
// startTriage's async flow, and startTriage always finalizes or the process
// is dead). Recovery therefore treats every such pair as interrupted, marks
// the task `blocked` with the retryable `interrupted` reason code, and
// finalizes the stale run as `blocked` — never touching the process/model
// layer, and never inventing an outcome the process never actually reached.
import type Database from '../sqlite/sync-database'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'

export type RecoveredInterruptedTriageRun = { taskId: string; runId: string; task: AuditedTaskRow }

function getTaskRow(db: Database.Database, taskId: string): AuditedTaskRow | null {
  const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToTask(row) : null
}

/**
 * Finds every `running` triage run, and for each, atomically (one
 * transaction per row): re-verifies the task is still `triaging` and the
 * run is still `running` (idempotent — a run already finalized by a
 * concurrent/prior recovery pass or a live process is skipped, not
 * double-processed), marks the run `blocked`/`interrupted`, and CAS-writes
 * the task to `blocked` with `pre_block_state='triaging'` so a later Retry
 * is legal. The transition history records the true prior state
 * (`triaging`) and the true reason (`interrupted`) — never a fabricated
 * provider outcome. Returns the recovered tasks so the caller can broadcast
 * their sanitized projections.
 */
export function recoverInterruptedTriageRuns(
  db: Database.Database,
  nowMs: number
): RecoveredInterruptedTriageRun[] {
  const runningRuns = db
    .prepare(`SELECT id, task_id FROM audited_triage_runs WHERE status = 'running'`)
    .all() as { id: string; task_id: string }[]

  const recovered: RecoveredInterruptedTriageRun[] = []
  for (const run of runningRuns) {
    const result = recoverOneRun(db, run.id, run.task_id, nowMs)
    if (result) {
      recovered.push(result)
    }
  }
  return recovered
}

function recoverOneRun(
  db: Database.Database,
  runId: string,
  taskId: string,
  nowMs: number
): RecoveredInterruptedTriageRun | null {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, taskId)
    // Why: a task can only legitimately have a `running` triage run while it
    // is `triaging` — if it moved on (or vanished), this run's `running`
    // status is stale bookkeeping from an already-handled interruption or a
    // race with another recovery pass; skip without writing anything, so
    // recovery is idempotent under repeated/concurrent invocation.
    if (!existing || existing.state !== 'triaging') {
      db.exec('ROLLBACK')
      return null
    }

    const runUpdateResult = db
      .prepare(
        `UPDATE audited_triage_runs
           SET status = 'blocked', reason_code = 'interrupted', ended_at_ms = ?
         WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(nowMs, runId, taskId)
    if (runUpdateResult.changes !== 1) {
      // Why: another recovery pass (or, in principle, a live finalize) won
      // this run first between the read above and this write — skip rather
      // than overwrite whatever outcome actually landed.
      db.exec('ROLLBACK')
      return null
    }

    const taskUpdateResult = db
      .prepare(
        `UPDATE audited_tasks
           SET state = 'blocked',
               pre_block_state = 'triaging',
               blocked_reason_code = 'interrupted',
               blocked_phase = 'triage',
               triage_run_status = 'blocked',
               triage_blocked_reason_code = 'interrupted',
               updated_at_ms = ?
         WHERE id = ? AND state = 'triaging'`
      )
      .run(nowMs, taskId)
    if (taskUpdateResult.changes !== 1) {
      db.exec('ROLLBACK')
      return null
    }

    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'triaging', 'blocked', 'control', 'triage_interrupted', 'interrupted', NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    const task = getTaskRow(db, taskId)
    if (!task) {
      throw new Error(`audited task ${taskId} vanished during interrupted-triage recovery`)
    }
    return { taskId, runId, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
