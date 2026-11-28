import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { RuntimeNotifierBinding } from '../../client/events/runtime-notifier-binding'

export abstract class NativeChatLaunchDraftOwner extends RuntimeNotifierBinding {
  /** The tab holding a launch draft and its workspace: a teammate's terminal's is their own list. */
  protected resolveNativeChatLaunchDraftOwner(
    handle: string
  ): { tabId: string; worktreeId: string } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    const pty = record.ptyId ? this.ptysById.get(record.ptyId) : null
    if (!record.tabId.startsWith('pty:')) {
      return { tabId: record.tabId, worktreeId: pty ? this.tabWorkspaceOf(pty) : record.worktreeId }
    }
    const pane = this.paneOfPty(pty)
    const tabId =
      pane.tabId && !pane.tabId.startsWith('pty:')
        ? pane.tabId
        : parsePaneKey(pane.paneKey ?? '')?.tabId
    if (!pty || !tabId || tabId.startsWith('pty:')) {
      return null
    }
    return { tabId, worktreeId: this.tabWorkspaceOf(pty) }
  }
}
