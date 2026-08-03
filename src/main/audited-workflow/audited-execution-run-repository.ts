// Persistence for execution runs (Phase 4). Isolated from
// audited-task-transitions.ts because starting/finalizing a run combines a
// task-state CAS with a row in audited_execution_runs inside ONE transaction —
// a distinct concurrency unit from the generic transition CAS.
//
// The invariant this file exists to hold: a successful start never leaves a task
// in its active execution state without inserting that run's `running` row in
// the same transaction.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { ExecutionMode } from '../../shared/audited-execution-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'
import {
  sqliteRowToExecutionRun,
  type AuditedExecutionRunRow
} from './audited-execution-run-mapping'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type ExecutionRepositoryFailureCode =
  | 'task_not_found'
  | 'illegal_transition'
  | 'lock_contended'

export type StartExecutionRunResult =
  | { ok: true; runId: string; task: AuditedTaskRow }
  | { ok: false; reasonCode: ExecutionRepositoryFailureCode }

export function generateExecutionRunId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `exec_${hex}`
}

export function getTaskRow(db: Database.Database, taskId: string): AuditedTaskRow | null {
  const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToTask(row) : null
}

export function getExecutionRun(
  db: Database.Database,
  runId: string
): AuditedExecutionRunRow | null {
  const row = db.prepare(`SELECT * FROM audited_execution_runs WHERE id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToExecutionRun(row) : null
}

export function getRunningExecutionRun(
  db: Database.Database,
  taskId: string
): AuditedExecutionRunRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_execution_runs WHERE task_id = ? AND status = 'running'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToExecutionRun(row) : null
}

export function getLatestExecutionRun(
  db: Database.Database,
  taskId: string
): AuditedExecutionRunRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_execution_runs WHERE task_id = ?
        ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToExecutionRun(row) : null
}

/**
 * Inserts the `running` row. Shared by start and retry so both write exactly the
 * same shape; must be called INSIDE an open transaction that has already
 * CAS-written the task state.
 *
 * Returns false on a partial-unique-index violation — the last line of defense
 * against a duplicate concurrent start, which the caller collapses to
 * `lock_contended`.
 */
export function insertRunningExecutionRow(
  db: Database.Database,
  args: {
    runId: string
    taskId: string
    mode: ExecutionMode
    preLaunchState: AuditedTaskState
    activeRunState: AuditedTaskState
    worktreeVerifiedAtMs: number
  },
  nowMs: number
): boolean {
  try {
    db.prepare(
      `INSERT INTO audited_execution_runs
         (id, task_id, mode, status, pre_launch_state, active_run_state,
          worktree_verified_at_ms, started_at_ms)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`
    ).run(
      args.runId,
      args.taskId,
      args.mode,
      args.preLaunchState,
      args.activeRunState,
      args.worktreeVerifiedAtMs,
      nowMs
    )
    return true
  } catch {
    return false
  }
}

export type StartExecutionRunArgs = {
  taskId: string
  mode: ExecutionMode
  /** The state observed before launch; also the CAS guard for the task update. */
  preLaunchState: AuditedTaskState
  activeRunState: AuditedTaskState
  worktreeVerifiedAtMs: number
}

/**
 * Starts an execution run: CAS the task into its active run state and insert the
 * `running` row, both inside one BEGIN IMMEDIATE transaction.
 *
 * For `direct` this moves ready_to_implement -> implementing via the existing
 * `implement` rule. For `plan` the task is ALREADY `planning` (triage put it
 * there), so no state change and no transition row is written — the run simply
 * begins. That asymmetry is why pre_launch_state and active_run_state are
 * recorded separately rather than derived.
 */
export function startExecutionRun(
  db: Database.Database,
  args: StartExecutionRunArgs,
  nowMs: number
): StartExecutionRunResult {
  const movesState = args.preLaunchState !== args.activeRunState
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, args.taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }
    if (existing.state !== args.preLaunchState) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    if (movesState) {
      // Direct mode only. Routed through the state machine so the legality of
      // ready_to_implement -> implementing has exactly one definition.
      const validation = validateAuditedTransition('implement', existing.state)
      if (!validation.ok || validation.rule.to !== args.activeRunState) {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'illegal_transition' }
      }

      const updated = db
        .prepare(`UPDATE audited_tasks SET state = ?, updated_at_ms = ? WHERE id = ? AND state = ?`)
        .run(args.activeRunState, nowMs, args.taskId, args.preLaunchState)
      if (updated.changes !== 1) {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'lock_contended' }
      }
    }

    const runId = generateExecutionRunId()
    if (
      !insertRunningExecutionRow(
        db,
        {
          runId,
          taskId: args.taskId,
          mode: args.mode,
          preLaunchState: args.preLaunchState,
          activeRunState: args.activeRunState,
          worktreeVerifiedAtMs: args.worktreeVerifiedAtMs
        },
        nowMs
      )
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    if (movesState) {
      db.prepare(
        `INSERT INTO audited_transitions
           (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
         VALUES (?, ?, ?, 'control', 'execution_started', NULL, NULL, ?)`
      ).run(args.taskId, args.preLaunchState, args.activeRunState, nowMs)
    }

    db.exec('COMMIT')
    const task = getTaskRow(db, args.taskId)
    if (!task) {
      throw new Error(`audited task ${args.taskId} vanished after starting execution`)
    }
    return { ok: true, runId, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Finalization lives in its own module (max-lines), but is re-exported here so
// callers keep one import site for the run lifecycle.
export {
  finalizeExecutionRun,
  type ExecutionOutputCounters,
  type FinalizeExecutionRunArgs,
  type FinalizeExecutionRunResult
} from './audited-execution-run-finalize'
