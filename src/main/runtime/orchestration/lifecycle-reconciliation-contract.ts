import type { MessageRow } from './types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** Shared vocabulary and authority checks for lifecycle reconciliation. Split
 *  out so the worker_done path and the heartbeat path can each stay readable. */
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
  | 'completion_receipt_invalid'

export type LifecycleRejectionResult = {
  action: 'rejected'
  code: LifecycleRejectionCode
  reason: string
}

export type LogFn = (msg: string) => void

export const noopLog: LogFn = () => {}

// Why: the tab half can change on pane break-out, while opaque legacy keys
// have no safe equivalence beyond exact equality.
export function isSamePane(assigneePaneKey: string, senderPaneKey: string): boolean {
  if (assigneePaneKey === senderPaneKey) {
    return true
  }
  const assigneeLeaf = parsePaneKey(assigneePaneKey)?.leafId
  const senderLeaf = parsePaneKey(senderPaneKey)?.leafId
  return Boolean(assigneeLeaf && senderLeaf && assigneeLeaf === senderLeaf)
}

export function hasLifecycleAuthority(
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

export function parseObjectPayload(
  msg: MessageRow,
  onInvalidJson: () => void
): Record<string, unknown> {
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

export function getPersistedLifecycleRejection(
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

export function buildLifecycleAuthorityRejectionReason(
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
