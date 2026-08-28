import type { OrchestrationDb } from './db'
import type { MessageRow } from './types'
import {
  buildLifecycleAuthorityRejectionReason,
  getPersistedLifecycleRejection,
  hasLifecycleAuthority,
  parseObjectPayload,
  type LifecycleReconciliationResult,
  type LogFn
} from './lifecycle-reconciliation-contract'

/** B4 compatibility: worker-generated heartbeats are no longer requested by the
 *  dispatch preamble, but an older preamble still in a live pane can send them,
 *  so the reconcile path stays exactly as it was. */
export function reconcileHeartbeatMessage(
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

export function suppressEarlierHeartbeats(
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
