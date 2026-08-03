// Shared fixtures for Phase 4 execution suites. Not a *.test.ts file so several
// suites can share it; test-only support, never imported by production code.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskRepository } from './audited-task-repository'
import type { ExecutionMode } from '../../shared/audited-execution-types'
import { startExecutionRun } from './audited-execution-run-repository'

export function modeStates(mode: ExecutionMode): {
  preLaunchState: 'planning' | 'ready_to_implement'
  activeRunState: 'planning' | 'implementing'
} {
  return mode === 'plan'
    ? { preLaunchState: 'planning', activeRunState: 'planning' }
    : { preLaunchState: 'ready_to_implement', activeRunState: 'implementing' }
}

/** Puts a task in the pre-launch state for `mode` and records the triage decision. */
export function seedTriagedTask(
  repository: AuditedTaskRepository,
  taskId: string,
  mode: ExecutionMode
): void {
  const { preLaunchState } = modeStates(mode)
  repository
    .getDatabase()
    .prepare(`UPDATE audited_tasks SET state = ?, triage_decision = ? WHERE id = ?`)
    .run(preLaunchState, mode, taskId)
}

/** Inserts a succeeded triage run carrying the Claude-ready prompt. */
export function seedTriageRun(
  db: Database.Database,
  taskId: string,
  nextStepPrompt: string | null
): void {
  db.prepare(
    `INSERT INTO audited_triage_runs (id, task_id, status, next_step_prompt, started_at_ms, ended_at_ms)
     VALUES (?, ?, 'succeeded', ?, 1, 2)`
  ).run(`triage_${taskId}`, taskId, nextStepPrompt)
}

/** Starts a run through the real repository CAS, returning its id. */
export function startRun(
  repository: AuditedTaskRepository,
  taskId: string,
  mode: ExecutionMode
): string {
  const { preLaunchState, activeRunState } = modeStates(mode)
  const started = startExecutionRun(
    repository.getDatabase(),
    { taskId, mode, preLaunchState, activeRunState, worktreeVerifiedAtMs: 10 },
    100
  )
  if (!started.ok) {
    throw new Error(`failed to start run: ${started.reasonCode}`)
  }
  return started.runId
}

export function executionRunCount(db: Database.Database, taskId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM audited_execution_runs WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

export function transitionRows(
  db: Database.Database,
  taskId: string
): {
  from_state: string | null
  to_state: string
  actor: string
  event_type: string
  reason_code: string | null
}[] {
  return db
    .prepare(
      `SELECT from_state, to_state, actor, event_type, reason_code
         FROM audited_transitions WHERE task_id = ? ORDER BY seq`
    )
    .all(taskId) as never
}

export function taskState(db: Database.Database, taskId: string): string {
  const row = db.prepare(`SELECT state FROM audited_tasks WHERE id = ?`).get(taskId) as {
    state: string
  }
  return row.state
}
