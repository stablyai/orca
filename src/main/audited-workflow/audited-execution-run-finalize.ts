// Finalization of an execution run (Phase 4). Split from
// audited-execution-run-repository.ts to stay under the max-lines budget
// without a suppression.
//
// TWO independent authorizations are required, and BOTH are checked before any
// write:
//  1. the execution row is still `running` (this call still owns the outcome);
//  2. the task is still in the state THIS RUN recorded as its active run state.
//
// The second matters because a concurrent writer — startup recovery, an
// invariant-violation block, a reconciliation — can move the task to `blocked`
// while the process is still going. Without check 2, this call would finalize
// the run and overwrite that block with a success it has no right to record.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { ExecutionReasonCode, ExecutionRunStatus } from '../../shared/audited-execution-types'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { getExecutionRun, getTaskRow } from './audited-execution-run-repository'
import {
  validateAuditedTransition,
  validateBlockTransition,
  type AuditedTransitionCommand
} from './audited-workflow-state-machine'

export type ExecutionOutputCounters = {
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  exitCode: number | null
}

export type FinalizeExecutionRunArgs = {
  runId: string
  taskId: string
  status: Exclude<ExecutionRunStatus, 'running'>
  reasonCode: ExecutionReasonCode | null
  /**
   * Where the task lands, validated through the state machine before any write.
   * Null means "leave the task state alone" (plan-mode same-state finalization),
   * which needs no rule.
   *
   * The state the task must ALREADY be in is deliberately NOT accepted here — it
   * is derived from the durable execution row inside the transaction, because a
   * caller's copy is read before a long-running process and is exactly the stale
   * value a concurrent block would exploit.
   */
  toState: AuditedTaskState | null
  /** Set only when toState is 'blocked'. */
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
  counters: ExecutionOutputCounters
}

export type FinalizeExecutionRunResult =
  | { ok: true; task: AuditedTaskRow }
  | { ok: false; reasonCode: 'task_not_found' | 'lock_contended' | 'illegal_transition' }

/**
 * Resolves the state-machine command that authorizes a finalize transition, so
 * this path can never write a task state the state machine would refuse.
 *
 * `blockFromInvariantViolation` covers every -> blocked edge (it is legal from
 * any non-terminal state), which is why blocking is validated separately from
 * the two success edges.
 */
function validateFinalizeTransition(
  fromState: AuditedTaskState,
  toState: AuditedTaskState
): boolean {
  if (toState === 'blocked') {
    return validateBlockTransition(fromState).ok
  }
  const command: AuditedTransitionCommand | null =
    fromState === 'planning' && toState === 'awaiting_plan_review'
      ? 'planComplete'
      : fromState === 'implementing' && toState === 'awaiting_code_audit'
        ? 'implementComplete'
        : null
  if (command === null) {
    return false
  }
  const validation = validateAuditedTransition(command, fromState)
  return validation.ok && validation.rule.to === toState
}

/**
 * Finalizes a run and moves the task, in one transaction.
 *
 * Any authorization mismatch rolls back EVERYTHING, including the execution-run
 * update, so a contended finalize leaves the run `running` for startup recovery
 * to classify honestly rather than recording an outcome this call did not earn.
 */
export function finalizeExecutionRun(
  db: Database.Database,
  args: FinalizeExecutionRunArgs,
  nowMs: number
): FinalizeExecutionRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getTaskRow(db, args.taskId)
    if (!existing) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    // Read the run FIRST so the expected task state comes from durable storage.
    const run = getExecutionRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }
    // The task must still be where this run lives. If it moved (e.g. a
    // concurrent block), this call is no longer authorized to record anything.
    if (existing.state !== run.activeRunState) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // Validate the intended task transition BEFORE any write. Plan-mode
    // same-state finalization (toState === null) writes no task state and needs
    // no rule, matching the start path's plan-mode asymmetry.
    if (args.toState !== null && !validateFinalizeTransition(existing.state, args.toState)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const runUpdate = db
      .prepare(
        `UPDATE audited_execution_runs
            SET status = ?, reason_code = ?, exit_code = ?, stdout_bytes = ?,
                stderr_bytes = ?, output_truncated = ?, ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(
        args.status,
        args.reasonCode,
        args.counters.exitCode,
        args.counters.stdoutBytes,
        args.counters.stderrBytes,
        args.counters.outputTruncated ? 1 : 0,
        nowMs,
        args.runId,
        args.taskId
      )
    if (runUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    if (args.toState !== null) {
      const fromState = existing.state
      const taskUpdate = db
        .prepare(
          `UPDATE audited_tasks
              SET state = ?, pre_block_state = ?, blocked_reason_code = ?,
                  blocked_phase = ?, updated_at_ms = ?
            WHERE id = ? AND state = ?`
        )
        .run(
          args.toState,
          args.preBlockState,
          args.blockedReasonCode,
          args.blockedPhase,
          nowMs,
          args.taskId,
          fromState
        )
      if (taskUpdate.changes !== 1) {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'lock_contended' }
      }

      db.prepare(
        `INSERT INTO audited_transitions
           (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(
        args.taskId,
        fromState,
        args.toState,
        args.toState === 'blocked' ? 'control' : 'claude',
        args.eventType,
        args.reasonCode,
        nowMs
      )
    }

    db.exec('COMMIT')
    const task = getTaskRow(db, args.taskId)
    if (!task) {
      throw new Error(`audited task ${args.taskId} vanished after finalizing execution`)
    }
    return { ok: true, task }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
