import type { WorkerReportOutcome, WorkerReportSettlement } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'
import { currentRemoteAttempt, remoteHoldOnTask } from '../remote-owned/remote-placements'

/**
 * The Task half of settlement, shared by every attempt wherever it ran: the Task takes the
 * attempt's result and its dependents become ready. `from` is the Task status the result settles:
 * dispatched; blocked, for a worker that reconnected; failed, for the unobserved-prompt correction.
 */
export function settleTaskForAttemptResult(
  db: OrchestrationDb,
  params: {
    taskId: string
    outcome: WorkerReportOutcome
    result: string
    from: 'dispatched' | 'blocked' | 'failed'
  }
): boolean {
  const now = new Date().toISOString()
  if (params.from === 'blocked') {
    transitionLifecycleWithDb(db.db, {
      entity: 'task',
      id: params.taskId,
      from: 'blocked',
      to: 'dispatched'
    })
  }
  const settled = transitionLifecycleWithDb(db.db, {
    entity: 'task',
    id: params.taskId,
    from: params.from === 'failed' ? 'failed' : 'dispatched',
    to: params.outcome === 'succeeded' ? 'completed' : 'failed',
    projection: { result: params.result, completed_at: now },
    ...(params.from === 'failed' ? { correction: 'unobserved_prompt_report' as const } : {})
  })
  if (!settled.changed) {
    return false
  }
  if (params.outcome === 'succeeded') {
    db.promoteReadyTasks(params.taskId)
  }
  return true
}

/** Another attempt of the Task whose worker still runs, here or on a paired server; its result is still to come. */
export function findConflictingActiveAttempt(
  db: OrchestrationDb,
  taskId: string,
  attemptId: string
): { id: string } | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const local = db.db
    .prepare(
      `SELECT active.id
       FROM dispatch_contexts active
       JOIN worker_dispatches worker ON worker.dispatch_id = active.id
       WHERE active.task_id = ? AND active.id != ?
         AND active.status IN ('pending', 'dispatched')
         AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
       ORDER BY active.rowid DESC LIMIT 1`
    )
    .get(taskId, attemptId) as { id: string } | undefined
  const remote = remoteHoldOnTask(db, taskId)
  return (
    local ??
    (remote?.liveWorker && remote.dispatchId !== attemptId
      ? { id: remote.dispatchId ?? '(a start on a paired server)' }
      : undefined)
  )
}

/**
 * A result from the paired server that ran the attempt: it already ran the execution half, so only
 * the Task half runs here. The first result stands; a duplicate is a no-op; only the Task's current
 * attempt there settles it. The unobserved-prompt correction is the server's decision, carried in.
 */
export function settleRemoteAttemptResult(
  this: OrchestrationDb,
  params: {
    taskId: string
    dispatchId: string
    outcome: WorkerReportOutcome
    result: string
    correctedUnobservedPrompt: boolean
  }
): WorkerReportSettlement {
  const transaction = beginLifecycleWriteTransaction(this.db, 'settle_remote_attempt_result')
  try {
    const settlement = settleRemoteAttemptResultInTransaction(this, params)
    if (settlement.action === 'rejected') {
      rollbackLifecycleWriteTransaction(this.db, transaction)
    } else {
      commitLifecycleWriteTransaction(this.db, transaction)
    }
    return settlement
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

function settleRemoteAttemptResultInTransaction(
  db: OrchestrationDb,
  params: Parameters<typeof settleRemoteAttemptResult>[0]
): WorkerReportSettlement {
  const task = db.getTask(params.taskId)
  if (!task) {
    return { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
  }
  const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  const correcting = params.correctedUnobservedPrompt && task.status === 'failed'
  if (!correcting && task.status === expectedTaskStatus) {
    return { action: 'settled', outcome: params.outcome, duplicate: true }
  }
  if (!correcting && task.status !== 'dispatched' && task.status !== 'blocked') {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
    }
  }
  if (currentRemoteAttempt(db, params.taskId)?.dispatch_id !== params.dispatchId) {
    return {
      action: 'rejected',
      code: 'stale_dispatch',
      reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
    }
  }
  const conflictingWorker = findConflictingActiveAttempt(db, params.taskId, params.dispatchId)
  if (conflictingWorker) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Task ${params.taskId} still has active supervised Dispatch ${conflictingWorker.id}; stop or settle it before completing ${params.dispatchId}.`
    }
  }
  const settled = settleTaskForAttemptResult(db, {
    taskId: params.taskId,
    outcome: params.outcome,
    result: params.result,
    from: correcting ? 'failed' : task.status === 'blocked' ? 'blocked' : 'dispatched'
  })
  return settled
    ? { action: 'settled', outcome: params.outcome, duplicate: false }
    : {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `Dispatch ${params.dispatchId} changed while its result was settling.`
      }
}
