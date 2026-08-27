import type { OrchestrationDb } from './db'
import type { MessageRow, WorkerReportOutcome } from './types'
import {
  advanceAfterAcceptedCompletion,
  evaluateCompletionGate,
  type LifecycleReconciliationHooks
} from './control-plane/completion-gate-enforcement'
import {
  reconcileHeartbeatMessage,
  suppressEarlierHeartbeats
} from './lifecycle-heartbeat-reconciliation'
import {
  buildLifecycleAuthorityRejectionReason,
  getPersistedLifecycleRejection,
  hasLifecycleAuthority,
  noopLog,
  parseObjectPayload,
  type LifecycleReconciliationResult,
  type LifecycleRejectionCode,
  type LifecycleRejectionResult,
  type LogFn
} from './lifecycle-reconciliation-contract'

export type {
  LifecycleReconciliationResult,
  LifecycleRejectionCode,
  LifecycleRejectionResult
} from './lifecycle-reconciliation-contract'

export function reconcileLifecycleMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: LogFn = noopLog,
  hooks?: LifecycleReconciliationHooks
): LifecycleReconciliationResult {
  switch (msg.type) {
    case 'worker_done':
      return reconcileWorkerDoneMessage(db, msg, onLog, hooks)
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

function reconcileWorkerDoneMessage(
  db: OrchestrationDb,
  msg: MessageRow,
  onLog: LogFn,
  hooks?: LifecycleReconciliationHooks
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
  // Why here: the gate runs after authority is proven and before any lifecycle
  // row is written, so a rejected completion leaves the Dispatch untouched.
  const gate = evaluateCompletionGate({
    handle: db,
    runId: dispatch.run_id,
    taskId,
    dispatchId,
    payload
  })
  if (gate.applies && !gate.ok) {
    return rejectLifecycleMessage(
      db,
      msg,
      'completion_receipt_invalid',
      `worker_done failed the ${gate.gate} gate (${gate.code}): ${gate.reason}`,
      onLog
    )
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
  if (gate.applies && gate.ok) {
    // Why here: the completion is now settled and proven, which is exactly the
    // point the reviewer phase, gate receipt, lease release and ledger entry
    // become derivable. Never on a rejected or unproven completion.
    advanceAfterAcceptedCompletion({
      db,
      // Why re-read: `dispatch` was loaded BEFORE settleWorkerReport, so its
      // status is still the pre-settlement one. The advance decides eligibility
      // from the accepted completion, and must see the settled row.
      dispatch: db.getDispatchContextById(dispatchId) ?? dispatch,
      taskId,
      payload,
      finalSha: gate.finalSha,
      outcomeOfReport: outcome as WorkerReportOutcome,
      onLog,
      hooks
    })
  }

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
