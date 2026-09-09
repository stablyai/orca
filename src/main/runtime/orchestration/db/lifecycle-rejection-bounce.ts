import type { DispatchContextRow, MessageRow } from '../types'
import {
  hasLifecycleRejectionMarker,
  addLifecycleRejectionMarker
} from './lifecycle-rejection-marker'
import { isEquivalentPaneKey } from './pane-key-match'
import type { OrchestrationDb } from './orchestration-db'

const CONVERT_SAVEPOINT = 'convert_lifecycle_rejection'
const ACTIVE_DISPATCH_STATUSES = new Set(['pending', 'dispatched'])

export function lifecycleRejectionBounceId(messageId: string): string {
  return `msg_lifecycle_rejection_${messageId}`
}

function dispatchMatchesSenderIdentity(
  dispatch: Pick<DispatchContextRow, 'assignee_handle' | 'assignee_pane_key'>,
  message: MessageRow
): boolean {
  return (
    dispatch.assignee_handle === message.from_handle ||
    Boolean(
      dispatch.assignee_pane_key &&
      message.sender_pane_key &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, message.sender_pane_key)
    )
  )
}

function checkReadableDispatchMailbox(
  dispatch: DispatchContextRow | undefined,
  message: MessageRow
): string | undefined {
  if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
    return undefined
  }
  if (message.run_id && dispatch.run_id !== message.run_id) {
    return undefined
  }
  if (!dispatchMatchesSenderIdentity(dispatch, message)) {
    return undefined
  }
  return `dispatch:${dispatch.id}`
}

/** Prefer the mailbox `check` actually reads: payload/active `dispatch:<id>`, else the handle. */
export function resolveLifecycleRejectionBounceTo(
  db: OrchestrationDb,
  message: MessageRow
): string {
  try {
    const parsed = message.payload
      ? (JSON.parse(message.payload) as { dispatchId?: unknown })
      : null
    const dispatchId =
      parsed && typeof parsed.dispatchId === 'string' ? parsed.dispatchId.trim() : ''
    if (dispatchId) {
      const mailbox = checkReadableDispatchMailbox(db.getDispatchContextById(dispatchId), message)
      if (mailbox) {
        return mailbox
      }
    }
  } catch {
    // Invalid JSON still falls through to the sender's active Dispatch or handle.
  }
  const active = db.getActiveDispatchForIdentity(
    message.from_handle,
    message.sender_pane_key ?? undefined
  )
  return checkReadableDispatchMailbox(active, message) ?? message.from_handle
}

export function convertLifecycleMessageToRejection(
  this: OrchestrationDb,
  messageId: string,
  code: string,
  reason: string
): MessageRow | undefined {
  const message = this.getMessageById(messageId)
  if (
    !message ||
    !['worker_done', 'heartbeat', 'escalation', 'decision_gate'].includes(message.type)
  ) {
    return message
  }

  const alreadyRejected = hasLifecycleRejectionMarker(message.payload)
  const rejectionSubject = alreadyRejected
    ? message.subject
    : `Rejected ${message.type}: ${message.subject}`
  const bounceId = lifecycleRejectionBounceId(messageId)
  this.db.exec(`SAVEPOINT ${CONVERT_SAVEPOINT}`)
  try {
    if (!alreadyRejected) {
      const originalBody = message.body ? `\n\nOriginal body:\n${message.body}` : ''
      const body = `Orca rejected this ${message.type}: ${reason}${originalBody}`
      const payload = addLifecycleRejectionMarker(message.payload, code, reason)
      // Why: rejected lifecycle signals stay auditable but must not reach read paths as actionable completion/liveness events.
      this.db
        .prepare(
          `UPDATE messages
           SET type = CASE WHEN type IN ('escalation', 'decision_gate') THEN 'status' ELSE type END,
               priority = 'high', subject = ?, body = ?, payload = ?
           WHERE id = ?`
        )
        .run(rejectionSubject, body, payload, messageId)
    }
    // Why: the deterministic ID makes replay idempotent; the savepoint keeps the
    // source rewrite and sender-visible bounce all-or-nothing.
    if (
      message.from_handle &&
      message.from_handle !== message.to_handle &&
      !this.getMessageById(bounceId)
    ) {
      this.insertMessage({
        id: bounceId,
        from: 'orca',
        to: resolveLifecycleRejectionBounceTo(this, message),
        subject: rejectionSubject,
        body: `Orca rejected your ${message.type}: ${reason}`,
        type: 'status',
        priority: 'high',
        payload: JSON.stringify({
          lifecycleRejection: true,
          rejectedMessageId: messageId,
          rejectedType: message.type,
          code,
          reason
        }),
        runId: message.run_id,
        deliveryContract: 'current_delivery'
      })
    }
    this.db.exec(`RELEASE ${CONVERT_SAVEPOINT}`)
  } catch (error) {
    this.db.exec(`ROLLBACK TO ${CONVERT_SAVEPOINT}`)
    this.db.exec(`RELEASE ${CONVERT_SAVEPOINT}`)
    throw error
  }
  return this.getMessageById(messageId)
}
