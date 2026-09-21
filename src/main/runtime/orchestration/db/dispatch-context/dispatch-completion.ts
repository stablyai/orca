import type { TaskStatus, DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from './dispatch-circuit-breaker'
import type { OrchestrationDb } from '../orchestration-db'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'

const FAIL_DISPATCH_SAVEPOINT = 'fail_dispatch'

export function completeDispatch(this: OrchestrationDb, ctxId: string): void {
  const dispatch = this.getDispatchContextById(ctxId)
  if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) {
    return
  }
  this.db.exec('SAVEPOINT complete_dispatch_transition')
  try {
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: ctxId,
      from: ['pending', 'dispatched'],
      to: 'completed',
      projection: {
        completed_at: new Date().toISOString(),
        capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString()
      }
    })
    // Why: a settled Dispatch can never be answered, and a pending thread on it kept the fleet row
    // demanding input after the work was done.
    this.closeQuestionsForDispatch(ctxId)
    this.db.exec('RELEASE complete_dispatch_transition')
  } catch (error) {
    this.db.exec('ROLLBACK TO complete_dispatch_transition')
    this.db.exec('RELEASE complete_dispatch_transition')
    throw error
  }
}

export function settleActiveDispatchesForTask(
  db: OrchestrationDb,
  taskId: string,
  status: 'completed' | 'failed',
  failure?: string
): void {
  const rows = db.db
    .prepare(
      "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')"
    )
    .all(taskId) as DispatchContextRow[]
  for (const row of rows) {
    transitionLifecycleWithDb(db.db, {
      entity: 'dispatch',
      id: row.id,
      from: row.status,
      to: status,
      projection: {
        completed_at: row.completed_at ?? new Date().toISOString(),
        last_failure:
          status === 'failed'
            ? (failure ?? row.last_failure ?? 'Task marked failed')
            : row.last_failure,
        capability_revoked_at: row.capability_revoked_at ?? new Date().toISOString()
      }
    })
    db.closeQuestionsForDispatch(row.id)
  }
}

export function completeActiveDispatchesForTask(this: OrchestrationDb, taskId: string): void {
  settleActiveDispatchesForTask(this, taskId, 'completed')
}

export function failActiveDispatchForTask(
  this: OrchestrationDb,
  taskId: string,
  error: string
): DispatchContextRow | undefined {
  const active = getActiveDispatchForTask(this, taskId)
  return active ? this.failDispatch(active.id, error) : undefined
}

// Why: only bump status='dispatched' — a zombie heartbeat from a finished dispatch would mask a hung retry from the stale detector (§5.3.4).
export function recordHeartbeat(this: OrchestrationDb, dispatchId: string, at: string): void {
  this.db
    .prepare(
      "UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'"
    )
    .run(at, dispatchId)
}

// Why: dispatched_at grace skips workers still within their first heartbeat interval; julianday() vs raw-TEXT compare avoids misflagging space-format timestamps as stale (#8452).
export function getStaleDispatches(
  this: OrchestrationDb,
  thresholdIso: string
): DispatchContextRow[] {
  return this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE status = 'dispatched'
         AND dispatched_at IS NOT NULL
         AND julianday(dispatched_at) < julianday(?)
         AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))`
    )
    .all(thresholdIso, thresholdIso) as DispatchContextRow[]
}

export function failDispatch(
  this: OrchestrationDb,
  ctxId: string,
  error: string,
  options: { workerProcessExited?: boolean; terminationReason?: string } = {}
): DispatchContextRow | undefined {
  // Why: reserve the WAL writer before lifecycle reads so a concurrent commit cannot cause SQLITE_BUSY_SNAPSHOT.
  const transaction = beginLifecycleWriteTransaction(this.db, FAIL_DISPATCH_SAVEPOINT)
  try {
    const before = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    const workerBefore = this.getWorkerDispatch(ctxId)
    if (!before || !['pending', 'dispatched'].includes(before.status)) {
      const worker = workerBefore
      if (
        before &&
        worker &&
        !['failed', 'succeeded', 'stopped', 'abandoned'].includes(worker.state) &&
        !options.workerProcessExited
      ) {
        throw new OrchestrationError(
          'task_not_startable',
          `Dispatch ${ctxId} has an active supervised worker; stop it or settle its report first.`,
          { dispatchId: ctxId }
        )
      }
      commitLifecycleWriteTransaction(this.db, transaction)
      return before
    }
    if (
      !options.workerProcessExited &&
      workerBefore &&
      !['failed', 'succeeded', 'stopped', 'abandoned'].includes(workerBefore.state)
    ) {
      throw new OrchestrationError(
        'task_not_startable',
        `Dispatch ${ctxId} has an active supervised worker; stop it or settle its report first.`,
        { dispatchId: ctxId }
      )
    }
    const nextStatus =
      before.failure_count + 1 >= DISPATCH_CIRCUIT_BREAK_FAILURES ? 'circuit_broken' : 'failed'
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: ctxId,
      from: before.status,
      to: nextStatus,
      projection: {
        failure_count: before.failure_count + 1,
        last_failure: error,
        termination_reason: options.terminationReason ?? before.termination_reason,
        completed_at: before.completed_at ?? new Date().toISOString(),
        capability_revoked_at: before.capability_revoked_at ?? new Date().toISOString()
      }
    })
    const ctx = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    if (!ctx) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return undefined
    }
    const worker = this.getWorkerDispatch(ctxId)
    if (worker && options.workerProcessExited) {
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: ctxId,
        from: worker.state,
        to: 'failed',
        projection: {
          stage: 'process_exited',
          last_error: error,
          updated_at: new Date().toISOString()
        }
      })
    }

    // Why: back to 'ready' not 'pending' — 'pending' would strand it since promoteReadyTasks only runs when a dep completes.
    const taskStatus: TaskStatus = ctx.status === 'circuit_broken' ? 'failed' : 'ready'
    // Why: the status guard keeps a late failure from reopening a task that already completed or was retried elsewhere.
    const task = this.getTask(ctx.task_id)
    if (
      task?.status === 'dispatched' &&
      !this.db
        .prepare(
          "SELECT 1 FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')"
        )
        .get(ctx.task_id)
    ) {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: ctx.task_id,
        from: 'dispatched',
        to: taskStatus,
        projection: { completed_at: taskStatus === 'failed' ? new Date().toISOString() : null }
      })
    }
    this.closeQuestionsForDispatch(ctxId)
    const updated = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    commitLifecycleWriteTransaction(this.db, transaction)
    return updated
  } catch (cause) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw cause
  }
}

export type DispatchCompletionMethods = {
  completeDispatch: typeof completeDispatch
  completeActiveDispatchesForTask: typeof completeActiveDispatchesForTask
  failActiveDispatchForTask: typeof failActiveDispatchForTask
  recordHeartbeat: typeof recordHeartbeat
  getStaleDispatches: typeof getStaleDispatches
  failDispatch: typeof failDispatch
}

export function attachDispatchCompletion(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    completeDispatch,
    completeActiveDispatchesForTask,
    failActiveDispatchForTask,
    recordHeartbeat,
    getStaleDispatches,
    failDispatch
  })
}
