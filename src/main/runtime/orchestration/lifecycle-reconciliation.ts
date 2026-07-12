import type { OrchestrationDb } from './db'
import type { MessageRow } from './types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

// Why: the tab half of a pane key changes when a pane is broken out into its
// own tab, so only the leaf UUID is identity. Reject only when both keys
// parse and name different leaves; an unparseable (e.g. legacy numeric) key
// degrades to payload authority rather than stranding a completion.
function isForeignPane(assigneePaneKey: string, senderPaneKey: string): boolean {
  if (assigneePaneKey === senderPaneKey) {
    return false
  }
  const assigneeLeaf = parsePaneKey(assigneePaneKey)?.leafId
  const senderLeaf = parsePaneKey(senderPaneKey)?.leafId
  return Boolean(assigneeLeaf && senderLeaf && assigneeLeaf !== senderLeaf)
}

export type LifecycleReconciliationResult =
  | { action: 'ignored' }
  // Why: `suppressed` means the message was consumed at reconcile time (marked
  // read); senders must not wake waiters for it, unlike `ignored` rows that
  // stay unread and still need delivery.
  | { action: 'suppressed' }
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

  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.status !== 'dispatched') {
    // Why: an in-flight heartbeat can arrive after completion; retain it for
    // audit history without surfacing obsolete liveness to the coordinator.
    db.markAsReadAndDelivered([msg.id])
    onLog(`Heartbeat for inactive dispatch ${dispatchId} suppressed`)
    return { action: 'suppressed' }
  }

  if (
    dispatch.assignee_pane_key &&
    msg.sender_pane_key &&
    isForeignPane(dispatch.assignee_pane_key, msg.sender_pane_key)
  ) {
    // Why: a wrong-pane heartbeat must not refresh liveness — it would mask
    // a hung assignee behind another agent's timer.
    onLog(
      `Heartbeat for dispatch ${dispatchId} came from pane ${msg.sender_pane_key}, expected pane ${dispatch.assignee_pane_key}; ignored`
    )
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
    // Why: pane leaves are the remint-stable identity behind handles. When
    // both sides carry one, a foreign leaf is a different pane completing
    // someone else's task — reject it; the same leaf is the same pane after
    // a handle remint or tab break-out. Without pane data (older CLI,
    // sessions without ORCA_PANE_KEY) payload IDs stay the completion
    // authority.
    if (
      dispatch.assignee_pane_key &&
      msg.sender_pane_key &&
      isForeignPane(dispatch.assignee_pane_key, msg.sender_pane_key)
    ) {
      onLog(
        `Warning: worker_done for dispatch ${dispatchId} came from pane ${msg.sender_pane_key}, expected pane ${dispatch.assignee_pane_key}; ignored`
      )
      return { action: 'ignored' }
    }
    onLog(
      `Warning: worker_done for dispatch ${dispatchId} came from ${msg.from_handle}, expected ${dispatch.assignee_handle ?? '<unknown>'}; accepting payload provenance`
    )
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
  suppressEarlierHeartbeats(db, msg, dispatchId)

  onLog(`Task ${taskId} completed`)
  return { action: 'completed', taskId, dispatchId }
}

function suppressEarlierHeartbeats(
  db: OrchestrationDb,
  workerDone: MessageRow,
  dispatchId: string
): void {
  const heartbeatIds = db
    .getUnreadMessages(workerDone.to_handle, ['heartbeat'])
    .filter((message) => {
      if (message.sequence >= workerDone.sequence) {
        return false
      }
      const payload = parseObjectPayload(message, () => undefined)
      return payload.dispatchId === dispatchId
    })
    .map((message) => message.id)
  db.markAsReadAndDelivered(heartbeatIds)
}
