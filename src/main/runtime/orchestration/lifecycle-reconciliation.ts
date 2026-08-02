import type { OrchestrationDb } from './db'
import type { MessageRow, WorkerReportOutcome } from './types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

// Why: the tab half can change on pane break-out, while opaque legacy keys
// have no safe equivalence beyond exact equality.
function isSamePane(assigneePaneKey: string, senderPaneKey: string): boolean {
  if (assigneePaneKey === senderPaneKey) {
    return true
  }
  const assigneeLeaf = parsePaneKey(assigneePaneKey)?.leafId
  const senderLeaf = parsePaneKey(senderPaneKey)?.leafId
  return Boolean(assigneeLeaf && senderLeaf && assigneeLeaf === senderLeaf)
}

function hasLifecycleAuthority(
  dispatch: { assignee_handle: string | null; assignee_pane_key: string | null },
  msg: MessageRow
): boolean {
  if (dispatch.assignee_pane_key) {
    return Boolean(
      msg.sender_pane_key && isSamePane(dispatch.assignee_pane_key, msg.sender_pane_key)
    )
  }
  // Why: rows created before pane identity existed can only use the exact
  // handle recorded at dispatch; payload knowledge alone is not authority.
  return dispatch.assignee_handle === msg.from_handle
}

export type LifecycleReconciliationResult =
  | { action: 'ignored' }
  // Why: `suppressed` means the message was consumed at reconcile time (marked
  // read); senders must not wake waiters for it, unlike `ignored` rows that
  // stay unread and still need delivery.
  | { action: 'suppressed' }
  | LifecycleRejectionResult
  | { action: 'completed'; taskId: string; dispatchId: string }
  | { action: 'failed'; taskId: string; dispatchId: string }
  | { action: 'heartbeat_recorded'; dispatchId: string }

export type LifecycleRejectionCode =
  | 'sender_not_assignee'
  | 'dispatch_capability_invalid'
  | 'invalid_payload'
  | 'missing_task_id'
  | 'missing_dispatch_id'
  | 'invalid_outcome'
  | 'unknown_task'
  | 'unknown_dispatch'
  | 'task_dispatch_mismatch'
  | 'inactive_dispatch'
  | 'stale_dispatch'

export type LifecycleRejectionResult = {
  action: 'rejected'
  code: LifecycleRejectionCode
  reason: string
}

type LogFn = (msg: string) => void

const noopLog: LogFn = () => {}

function parseObjectPayload(msg: MessageRow, onInvalidJson: () => void): Record<string, unknown> {
  if (!msg.payload) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(msg.payload)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    onInvalidJson()
    return {}
  } catch {
    onInvalidJson()
    return {}
  }
}

function getPersistedLifecycleRejection(
  payload: Record<string, unknown>
): LifecycleRejectionResult | undefined {
  const rejection = payload._orcaLifecycleRejection
  if (
    !rejection ||
    typeof rejection !== 'object' ||
    typeof (rejection as { code?: unknown }).code !== 'string' ||
    typeof (rejection as { reason?: unknown }).reason !== 'string'
  ) {
    return undefined
  }
  // Why: the marker is reserved persistence state; treating it as a rejection
  // also prevents caller-supplied markers from turning lifecycle sends into success.
  return {
    action: 'rejected',
    code: (rejection as { code: LifecycleRejectionCode }).code,
    reason: (rejection as { reason: string }).reason
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
    case 'question':
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
  const persistedRejection = getPersistedLifecycleRejection(payload)
  if (persistedRejection) {
    // Why: the send-path reconcile converts with a no-op logger, so the
    // coordinator's re-read is the only chance to surface the rejection.
    onLog(`Heartbeat rejected: ${persistedRejection.reason}`)
    return persistedRejection
  }
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

  if (!hasLifecycleAuthority(dispatch, msg)) {
    // Why: a wrong-pane heartbeat must not refresh liveness — it would mask
    // a hung assignee behind another agent's timer.
    const reason = buildLifecycleAuthorityRejectionReason(dispatchId, dispatch, msg)
    onLog(`Heartbeat rejected: ${reason}`)
    db.convertLifecycleMessageToRejection(msg.id, 'sender_not_assignee', reason)
    return { action: 'rejected', code: 'sender_not_assignee', reason }
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

  let invalidPayload = false
  const payload = parseObjectPayload(msg, () => {
    invalidPayload = true
    onLog(`Warning: invalid payload in worker_done from ${msg.from_handle}`)
  })
  const persistedRejection = getPersistedLifecycleRejection(payload)
  if (persistedRejection) {
    // Why: the send-path reconcile converts with a no-op logger, so the
    // coordinator's re-read is the only chance to surface the rejection.
    onLog(`Warning: worker_done rejected: ${persistedRejection.reason}`)
    return persistedRejection
  }
  if (invalidPayload || !msg.payload) {
    return rejectLifecycleMessage(
      db,
      msg,
      'invalid_payload',
      'worker_done requires a JSON object payload.',
      onLog
    )
  }

  const taskId = payload.taskId
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return rejectLifecycleMessage(db, msg, 'missing_task_id', 'worker_done requires taskId.', onLog)
  }

  const dispatchId = payload.dispatchId
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    return rejectLifecycleMessage(
      db,
      msg,
      'missing_dispatch_id',
      'worker_done requires dispatchId.',
      onLog
    )
  }

  const outcome = payload.outcome
  if (outcome !== 'succeeded' && outcome !== 'failed') {
    return rejectLifecycleMessage(
      db,
      msg,
      'invalid_outcome',
      'worker_done requires outcome=succeeded or outcome=failed.',
      onLog
    )
  }

  const task = db.getTask(taskId)
  if (!task) {
    return rejectLifecycleMessage(
      db,
      msg,
      'unknown_task',
      `worker_done references unknown task ${taskId}.`,
      onLog
    )
  }

  // Why: taskId alone is not a completion authority; retried tasks can have
  // stale worker_done messages racing the current active dispatch.
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return rejectLifecycleMessage(
      db,
      msg,
      'unknown_dispatch',
      `worker_done references unknown dispatch ${dispatchId}.`,
      onLog
    )
  }
  if (dispatch.task_id !== taskId) {
    return rejectLifecycleMessage(
      db,
      msg,
      'task_dispatch_mismatch',
      `worker_done dispatch ${dispatchId} belongs to ${dispatch.task_id}, not ${taskId}.`,
      onLog
    )
  }
  if (!hasLifecycleAuthority(dispatch, msg)) {
    const reason = buildLifecycleAuthorityRejectionReason(dispatchId, dispatch, msg)
    onLog(`Warning: worker_done rejected: ${reason}`)
    db.convertLifecycleMessageToRejection(msg.id, 'sender_not_assignee', reason)
    return { action: 'rejected', code: 'sender_not_assignee', reason }
  }
  // Why: `orchestration.send` can release the DB lock before waking the
  // coordinator; the later coordinator read still needs to observe completion.
  const filesModified =
    Array.isArray(payload.filesModified) &&
    payload.filesModified.every((file) => typeof file === 'string')
      ? payload.filesModified
      : []

  const result = JSON.stringify({
    provenance: 'worker_report',
    outcome,
    messageId: msg.id,
    reportedBy: msg.from_handle,
    subject: msg.subject,
    body: msg.body,
    completedBy: msg.from_handle,
    filesModified,
    reportPath: typeof payload.reportPath === 'string' ? payload.reportPath : null,
    completedAt: new Date().toISOString()
  })
  const settlement = db.settleWorkerReport({
    taskId,
    dispatchId,
    outcome: outcome as WorkerReportOutcome,
    result
  })
  if (settlement.action === 'rejected') {
    return rejectLifecycleMessage(db, msg, settlement.code, settlement.reason, onLog)
  }
  suppressEarlierHeartbeats(db, msg, dispatchId)

  if (outcome === 'failed') {
    onLog(`Task ${taskId} failed by worker report`)
    return { action: 'failed', taskId, dispatchId }
  }
  onLog(`Task ${taskId} completed by worker report`)
  return { action: 'completed', taskId, dispatchId }
}

function rejectLifecycleMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  code: LifecycleRejectionCode,
  reason: string,
  onLog: LogFn
): LifecycleRejectionResult {
  onLog(`Warning: ${msg.type} rejected: ${reason}`)
  db.convertLifecycleMessageToRejection(msg.id, code, reason)
  return { action: 'rejected', code, reason }
}

function buildLifecycleAuthorityRejectionReason(
  dispatchId: string,
  dispatch: { assignee_handle: string | null; assignee_pane_key: string | null },
  msg: MessageRow
): string {
  return (
    `dispatch ${dispatchId} expected handle ${dispatch.assignee_handle ?? '<unknown>'}, ` +
    `pane ${dispatch.assignee_pane_key ?? '<legacy>'}; received handle ${msg.from_handle}, ` +
    `pane ${msg.sender_pane_key ?? '<missing>'}`
  )
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
