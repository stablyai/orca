import type { OrchestrationDb } from './db'
import type { MessageRow } from './types'

export type LifecycleReconciliationResult =
  | { action: 'ignored' }
  | { action: 'completed'; taskId: string; dispatchId: string }
  | { action: 'heartbeat_recorded'; dispatchId: string }

type LogFn = (msg: string) => void

const noopLog: LogFn = () => {}

function parseObjectPayload(msg: MessageRow, onInvalidJson: () => void): Record<string, unknown> {
  if (!msg.payload) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(msg.payload)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    onInvalidJson()
    return {}
  }
}

export function reconcileLifecycleMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: LogFn = noopLog
): LifecycleReconciliationResult {
  switch (msg.type) {
    case 'worker_done':
      return reconcileWorkerDoneMessage(db, msg, onLog)
    case 'heartbeat':
      return reconcileHeartbeatMessage(db, msg, onLog)
    case 'status':
    case 'dispatch':
    case 'merge_ready':
    case 'escalation':
    case 'handoff':
    case 'decision_gate':
      return { action: 'ignored' }
  }
}

function reconcileHeartbeatMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: LogFn
): LifecycleReconciliationResult {
  if (!msg.payload) {
    onLog(`Heartbeat from ${msg.from_handle} missing payload; ignored`)
    return { action: 'ignored' }
  }

  const payload = parseObjectPayload(msg, () => {
    onLog(`Heartbeat from ${msg.from_handle} has invalid JSON payload; ignored`)
  })
  const dispatchId = payload.dispatchId
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    onLog(`Heartbeat from ${msg.from_handle} missing dispatchId; ignored`)
    return { action: 'ignored' }
  }

  // Why: dispatchId-specific writes let the DB ignore late heartbeats for
  // completed/failed retries without masking a newer hung dispatch.
  db.recordHeartbeat(dispatchId, msg.created_at)
  return { action: 'heartbeat_recorded', dispatchId }
}

function reconcileWorkerDoneMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: LogFn
): LifecycleReconciliationResult {
  onLog(`Worker done: ${msg.from_handle} — ${msg.subject}`)

  const payload = parseObjectPayload(msg, () => {
    onLog(`Warning: invalid payload in worker_done from ${msg.from_handle}`)
  })

  const taskId = payload.taskId
  if (typeof taskId !== 'string' || taskId.length === 0) {
    onLog(`Warning: worker_done without taskId from ${msg.from_handle}`)
    return { action: 'ignored' }
  }

  const dispatchId = payload.dispatchId
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    onLog(`Warning: worker_done without dispatchId from ${msg.from_handle}`)
    return { action: 'ignored' }
  }

  const task = db.getTask(taskId)
  if (!task) {
    onLog(`Warning: worker_done for unknown task ${taskId}`)
    return { action: 'ignored' }
  }

  // Why: taskId alone is not a completion authority; retried tasks can have
  // stale worker_done messages racing the current active dispatch.
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    onLog(`Warning: worker_done for unknown dispatch ${dispatchId}`)
    return { action: 'ignored' }
  }
  if (dispatch.task_id !== taskId) {
    onLog(
      `Warning: worker_done dispatch ${dispatchId} belongs to ${dispatch.task_id}, not ${taskId}`
    )
    return { action: 'ignored' }
  }
  if (dispatch.assignee_handle !== msg.from_handle) {
    onLog(
      `Warning: worker_done for dispatch ${dispatchId} came from ${msg.from_handle}, expected ${dispatch.assignee_handle ?? '<unknown>'}`
    )
    return { action: 'ignored' }
  }
  // Why: `orchestration.send` can release the DB lock before waking the
  // coordinator; the later coordinator read still needs to observe completion.
  if (dispatch.status === 'completed' && task.status === 'completed') {
    return { action: 'completed', taskId, dispatchId }
  }
  if (dispatch.status !== 'dispatched') {
    onLog(`Warning: worker_done for inactive dispatch ${dispatchId} ignored`)
    return { action: 'ignored' }
  }
  if (db.getDispatchContext(taskId)?.id !== dispatchId || task.status !== 'dispatched') {
    onLog(`Warning: worker_done for stale dispatch ${dispatchId} ignored`)
    return { action: 'ignored' }
  }

  const filesModified =
    Array.isArray(payload.filesModified) &&
    payload.filesModified.every((file) => typeof file === 'string')
      ? payload.filesModified
      : []

  const result = JSON.stringify({
    completedBy: msg.from_handle,
    filesModified,
    completedAt: new Date().toISOString()
  })
  db.updateTaskStatus(taskId, 'completed', result)

  onLog(`Task ${taskId} completed`)
  return { action: 'completed', taskId, dispatchId }
}
