import type { TaskStatus, DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from './dispatch-circuit-breaker'
import type { OrchestrationDb } from '../orchestration-db'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../row-column-lists'
import { settleWorkerForCompletedDispatch } from '../worker-dispatch/worker-dispatch-settlement'
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
    // Settled Dispatches cannot answer questions; close them to clear fleet input demands.
    this.closeQuestionsForDispatch(ctxId)
    settleWorkerForCompletedDispatch(this.db, ctxId)
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
  const transaction = beginLifecycleWriteTransaction(db.db, 'settle_task_dispatches')
  try {
    const rawRows = db.db
      .prepare(
        `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')`
      )
      .all(taskId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing complete Dispatch projection is pinned to this table's schema by row-column-lists.test.ts.
    const rows = rawRows as DispatchContextRow[]
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
      settleWorkerForCompletedDispatch(db.db, row.id)
    }
    commitLifecycleWriteTransaction(db.db, transaction)
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
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

// Late heartbeats from settled Dispatches must not mask a hung retry.
export function recordHeartbeat(this: OrchestrationDb, dispatchId: string, at: string): void {
  this.db
    .prepare(
      "UPDATE dispatch_contexts SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'"
    )
    .run(at, dispatchId)
}

// Allow first-heartbeat grace and compare parsed dates to handle SQLite and ISO formats (#8452).
export function getStaleDispatches(
  this: OrchestrationDb,
  thresholdIso: string
): DispatchContextRow[] {
  const rows = this.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE status = 'dispatched'
         AND dispatched_at IS NOT NULL
         AND julianday(dispatched_at) < julianday(?)
         AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) < julianday(?))`
    )
    .all(thresholdIso, thresholdIso)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing complete Dispatch projection is pinned to this table's schema by row-column-lists.test.ts.
  return rows as DispatchContextRow[]
}

export function failDispatch(
  this: OrchestrationDb,
  ctxId: string,
  error: string,
  options: { workerProcessExited?: boolean; terminationReason?: string; workerStage?: string } = {}
): DispatchContextRow | undefined {
  // Reserve the WAL writer before reading to prevent SQLITE_BUSY_SNAPSHOT.
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
    const rawContext = this.db
      .prepare(`SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE id = ?`)
      .get(ctxId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns one Dispatch row or undefined; the adapter exposes unknown.
    const ctx = rawContext as DispatchContextRow | undefined
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
          stage: options.workerStage ?? 'process_exited',
          last_error: error,
          updated_at: new Date().toISOString()
        }
      })
    }

    // Retry as ready: pending tasks are promoted only when a dependency completes.
    const taskStatus: TaskStatus = ctx.status === 'circuit_broken' ? 'failed' : 'ready'
    // A late failure must not reopen a completed or independently retried task.
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
