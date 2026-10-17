import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { MessageRow } from './types'

function isSamePane(assigneePaneKey: string, senderPaneKey: string): boolean {
  if (assigneePaneKey === senderPaneKey) {
    return true
  }
  const assigneeLeaf = parsePaneKey(assigneePaneKey)?.leafId
  const senderLeaf = parsePaneKey(senderPaneKey)?.leafId
  return Boolean(assigneeLeaf && senderLeaf && assigneeLeaf === senderLeaf)
}

export function hasLifecycleMessageAuthority(
  dispatch: { assignee_handle: string | null; assignee_pane_key: string | null },
  msg: MessageRow
): boolean {
  if (dispatch.assignee_pane_key) {
    return Boolean(
      msg.sender_pane_key && isSamePane(dispatch.assignee_pane_key, msg.sender_pane_key)
    )
  }
  return dispatch.assignee_handle === msg.from_handle
}

export function lifecycleAuthorityRejectionReason(
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
