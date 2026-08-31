import type { WorkerReportOutcome, WorkerReportSettlement } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { AGENT_PROMPT_STALLED_ERROR } from '../../../agent-prompt-submission-verification'
import { settleActiveDispatchesForTask } from './dispatch-completion'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'

export function settleWorkerReport(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }
): WorkerReportSettlement {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const settlement = this.settleWorkerReportInTransaction(params)
    this.db.exec('COMMIT')
    return settlement
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function settleWorkerReportInTransaction(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
  }
): WorkerReportSettlement {
  const task = this.getTask(params.taskId)
  if (!task) {
    return { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
  }
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    return {
      action: 'rejected',
      code: 'unknown_dispatch',
      reason: `Unknown dispatch ${params.dispatchId}.`
    }
  }
  if (dispatch.task_id !== params.taskId) {
    return {
      action: 'rejected',
      code: 'task_dispatch_mismatch',
      reason: `Dispatch ${params.dispatchId} belongs to task ${dispatch.task_id}, not ${params.taskId}.`
    }
  }

  const expectedDispatchStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  // Why (#16095): worker-start records a stalled prompt as failed, but the preamble was written
  // before verification ran — the worker may have been executing it the whole time. Its own report
  // is first-hand evidence and must be able to correct that record instead of being thrown away.
  // Checked before the duplicate short-circuit: a `failed` report lands on the very statuses that
  // short-circuit reads as already settled, dropping the worker's real cause and result body.
  const settledByUnobservedPrompt =
    dispatch.status === 'failed' &&
    dispatch.last_failure === AGENT_PROMPT_STALLED_ERROR &&
    task.status === 'failed'
  if (
    !settledByUnobservedPrompt &&
    dispatch.status === expectedDispatchStatus &&
    task.status === expectedTaskStatus
  ) {
    return { action: 'settled', outcome: params.outcome, duplicate: true }
  }
  const previous = settledByUnobservedPrompt
    ? { status: 'failed', workerState: 'failed' }
    : { status: 'dispatched', workerState: 'ready' }
  if (dispatch.status !== previous.status || task.status !== previous.status) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
    }
  }
  const conflictingWorker = this.db
    .prepare(
      `SELECT active.id
       FROM dispatch_contexts active
       JOIN worker_dispatches worker ON worker.dispatch_id = active.id
       WHERE active.task_id = ? AND active.id != ?
         AND active.status IN ('pending', 'dispatched')
         AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
       ORDER BY active.rowid DESC LIMIT 1`
    )
    .get(params.taskId, params.dispatchId) as { id: string } | undefined
  if (conflictingWorker) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Task ${params.taskId} still has active supervised Dispatch ${conflictingWorker.id}; stop or settle it before completing ${params.dispatchId}.`
    }
  }
  const reportingWorker = this.getWorkerDispatch(params.dispatchId)
  const latest = getActiveDispatchForTask(this, params.taskId)
  if (!reportingWorker && latest?.id !== params.dispatchId) {
    return {
      action: 'rejected',
      code: 'stale_dispatch',
      reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
    }
  }
  const siblingDispatchIds = this.db
    .prepare(
      `SELECT id FROM dispatch_contexts
       WHERE task_id = ? AND id != ? AND status IN ('pending', 'dispatched')`
    )
    .all(params.taskId, params.dispatchId) as { id: string }[]

  this.db.exec('SAVEPOINT settle_worker_report')
  const dispatchUpdate = this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET status = ?, completed_at = datetime('now'),
           last_failure = CASE WHEN ? = 'failed' THEN ? ELSE last_failure END,
           capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
       WHERE id = ? AND status = ?`
    )
    .run(
      expectedDispatchStatus,
      expectedDispatchStatus,
      params.result,
      params.dispatchId,
      previous.status
    )
  const taskUpdate = this.db
    .prepare(
      `UPDATE tasks
       SET status = ?, result = ?, completed_at = datetime('now')
       WHERE id = ? AND status = ?`
    )
    .run(expectedTaskStatus, params.result, params.taskId, previous.status)
  if (dispatchUpdate.changes !== 1 || taskUpdate.changes !== 1) {
    this.db.exec('ROLLBACK TO settle_worker_report')
    this.db.exec('RELEASE settle_worker_report')
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Dispatch ${params.dispatchId} changed while its worker report was settling.`
    }
  }
  this.db
    .prepare(
      `UPDATE worker_dispatches
       SET state = ?, stage = 'settled', updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = ?`
    )
    .run(
      params.outcome === 'succeeded' ? 'succeeded' : 'failed',
      params.dispatchId,
      previous.workerState
    )
  settleActiveDispatchesForTask(
    this,
    params.taskId,
    expectedDispatchStatus,
    params.outcome === 'failed' ? params.result : undefined
  )
  this.closeQuestionsForDispatch(params.dispatchId)
  for (const sibling of siblingDispatchIds) {
    this.closeQuestionsForDispatch(sibling.id)
  }
  if (params.outcome === 'succeeded') {
    this.promoteReadyTasks(params.taskId)
  }
  this.db.exec('RELEASE settle_worker_report')
  return { action: 'settled', outcome: params.outcome, duplicate: false }
}

export type WorkerReportSettlementMethods = {
  settleWorkerReport: typeof settleWorkerReport
  settleWorkerReportInTransaction: typeof settleWorkerReportInTransaction
}

export function attachWorkerReportSettlement(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    settleWorkerReport,
    settleWorkerReportInTransaction
  })
}
