import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { RuntimeNotifierBinding } from '../../client/events/runtime-notifier-binding'

export abstract class NativeChatLaunchDraftOwner extends RuntimeNotifierBinding {
  protected resolveNativeChatLaunchDraftOwner(
    handle: string
  ): { tabId: string; worktreeId: string } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (!record.tabId.startsWith('pty:')) {
      return { tabId: record.tabId, worktreeId: record.worktreeId }
    }
    const pty = record.ptyId ? this.ptysById.get(record.ptyId) : null
    const pane = this.paneOfPty(pty)
    const tabId =
      pane.tabId && !pane.tabId.startsWith('pty:')
        ? pane.tabId
        : parsePaneKey(pane.paneKey ?? '')?.tabId
    if (!pty || !tabId || tabId.startsWith('pty:')) {
      return null
    }
    return { tabId, worktreeId: pty.worktreeId }
  }
}
