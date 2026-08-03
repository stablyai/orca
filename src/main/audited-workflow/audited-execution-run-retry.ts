// Retry of an execution-blocked task (Phase 4 §2).
//
// This module owns RETRYABLE_EXECUTION_REASON_CODES as the SERVER-SIDE
// authority. The renderer helper only decides whether a button is drawn; it is
// never the gate.
//
// The worktree preflight is the caller's responsibility and MUST have already
// succeeded before this runs — see audited-execution-orchestration.ts, which
// calls verifyWorktreeForTask (read-only) while the task stays `blocked`. No
// `running` row may exist before that verification passes.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { ExecutionMode } from '../../shared/audited-execution-types'
import { RETRYABLE_EXECUTION_REASON_CODES } from '../../shared/audited-execution-types'
import {
  generateExecutionRunId,
  getLatestExecutionRun,
  getTaskRow,
  insertRunningExecutionRow
} from './audited-execution-run-repository'
import { validateRetryTransition } from './audited-workflow-state-machine'
import type { AuditedTaskRow } from './audited-task-row-mapping'

export type RetryExecutionRunResult =
  | { ok: true; runId: string; task: AuditedTaskRow; mode: ExecutionMode }
  | { ok: false; reasonCode: 'task_not_found' | 'illegal_transition' | 'lock_contended' }

// The states an execution block can be resumed to. A task blocked by any other
// phase (triage, provisioning) is refused here and must use its own retry path.
const EXECUTION_PRE_BLOCK_STATES: readonly AuditedTaskState[] = ['planning', 'implementing']

export function isExecutionBlockedTask(task: AuditedTaskRow): boolean {
  return (
    task.state === 'blocked' &&
    task.preBlockState !== null &&
    EXECUTION_PRE_BLOCK_STATES.includes(task.preBlockState)
  )
}

/**
 * Unblocks the task and inserts a fresh `running` row in ONE transaction.
 *
 * Eligibility is re-checked INSIDE the transaction because the caller's
 * read-only worktree preflight may have taken seconds, making its pre-read
 * stale.
 */
export function retryExecutionRun(
  db: Database.Database,
  args: { taskId: string; worktreeVerifiedAtMs: number },
  nowMs: number
): RetryExecutionRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = getTaskRow(db, args.taskId)
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }
    if (!isExecutionBlockedTask(task)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const latest = getLatestExecutionRun(db, args.taskId)
    if (!latest || latest.status === 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    // The closed retryable set, enforced here rather than in the renderer.
    if (
      latest.reasonCode === null ||
      !RETRYABLE_EXECUTION_REASON_CODES.includes(latest.reasonCode)
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    // Dynamic target resolved by the existing validator, unchanged.
    const validation = validateRetryTransition(task.state, task.preBlockState)
    if (!validation.ok) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    const resumeState = validation.rule.to

    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = ?, pre_block_state = NULL, blocked_reason_code = NULL,
                blocked_phase = NULL, updated_at_ms = ?
          WHERE id = ? AND state = 'blocked'`
      )
      .run(resumeState, nowMs, args.taskId)
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const runId = generateExecutionRunId()
    if (
      !insertRunningExecutionRow(
        db,
        {
          runId,
          taskId: args.taskId,
          mode: latest.mode,
          // Carried forward from the prior run so a cancel after retry still
          // restores the true pre-launch state rather than re-deriving it.
          preLaunchState: latest.preLaunchState,
          activeRunState: resumeState,
          worktreeVerifiedAtMs: args.worktreeVerifiedAtMs
        },
        nowMs
      )
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'blocked', ?, 'human', 'execution_retried', ?, NULL, ?)`
    ).run(args.taskId, resumeState, latest.reasonCode, nowMs)

    db.exec('COMMIT')
    const updated = getTaskRow(db, args.taskId)
    if (!updated) {
      throw new Error(`audited task ${args.taskId} vanished after retrying execution`)
    }
    return { ok: true, runId, task: updated, mode: latest.mode }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
