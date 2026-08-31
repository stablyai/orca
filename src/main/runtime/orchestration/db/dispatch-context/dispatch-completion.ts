import type { TaskStatus, DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from './dispatch-circuit-breaker'
import type { OrchestrationDb } from '../orchestration-db'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'

const FAIL_DISPATCH_SAVEPOINT = 'fail_dispatch'

export function completeDispatch(this: OrchestrationDb, ctxId: string): void {
  this.db
    .prepare(
      // Why: the status guard keeps a late completion from reviving a dispatch already failed or circuit-broken.
      "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now'), capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ? AND status IN ('pending', 'dispatched')"
    )
    .run(ctxId)
}

export function settleActiveDispatchesForTask(
  db: OrchestrationDb,
  taskId: string,
  status: 'completed' | 'failed',
  failure?: string
): void {
  db.db
    .prepare(
      `UPDATE dispatch_contexts
       SET status = ?, completed_at = COALESCE(completed_at, datetime('now')),
           last_failure = CASE
             WHEN ? = 'failed' THEN COALESCE(?, last_failure, 'Task marked failed')
             ELSE last_failure
           END,
           capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
       WHERE task_id = ? AND status IN ('pending', 'dispatched')`
    )
    .run(status, status, failure ?? null, taskId)
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
  this.db.exec(`SAVEPOINT ${FAIL_DISPATCH_SAVEPOINT}`)
  try {
    const result = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = CASE WHEN failure_count + 1 >= ? THEN 'circuit_broken' ELSE 'failed' END,
             failure_count = failure_count + 1, last_failure = ?,
             termination_reason = COALESCE(?, termination_reason),
             completed_at = COALESCE(completed_at, datetime('now')),
             capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
         WHERE id = ? AND status IN ('pending', 'dispatched')
           AND (? = 1 OR NOT EXISTS (
             SELECT 1 FROM worker_dispatches worker
             WHERE worker.dispatch_id = dispatch_contexts.id
               AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
           ))`
      )
      .run(
        DISPATCH_CIRCUIT_BREAK_FAILURES,
        error,
        options.terminationReason ?? null,
        ctxId,
        options.workerProcessExited ? 1 : 0
      )
    const ctx = this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
    const worker = this.getWorkerDispatch(ctxId)
    if (result.changes !== 1 || !ctx) {
      if (
        ctx &&
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
      this.db.exec(`RELEASE ${FAIL_DISPATCH_SAVEPOINT}`)
      return ctx
    }
    if (worker && options.workerProcessExited) {
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'failed', stage = 'process_exited', last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?
             AND state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')`
        )
        .run(error, ctxId)
    }

    // Why: back to 'ready' not 'pending' — 'pending' would strand it since promoteReadyTasks only runs when a dep completes.
    const taskStatus: TaskStatus = ctx.status === 'circuit_broken' ? 'failed' : 'ready'
    // Why: the status guard keeps a late failure from reopening a task that already completed or was retried elsewhere.
    this.db
      .prepare(
        `UPDATE tasks SET status = ?
         WHERE id = ? AND status = 'dispatched' AND NOT EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
         )`
      )
      .run(taskStatus, ctx.task_id)
    this.db.exec(`RELEASE ${FAIL_DISPATCH_SAVEPOINT}`)
    return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(ctxId) as
      | DispatchContextRow
      | undefined
  } catch (cause) {
    this.db.exec(`ROLLBACK TO ${FAIL_DISPATCH_SAVEPOINT}`)
    this.db.exec(`RELEASE ${FAIL_DISPATCH_SAVEPOINT}`)
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
