import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { RuntimeWorkspaceArchive } from '../../workspaces/archive/runtime-workspace-archive'

export abstract class RuntimeTerminalNames extends RuntimeWorkspaceArchive {
  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    // Switch point: a terminal main owns is renamed in main's layout, with or without a window.
    const mainRename = ORCA_LAYOUT_OWNER_IS_MAIN
      ? await this.renameTerminalInMainLayout(handle, title)
      : null
    if (mainRename) {
      return mainRename
    }
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      // Keep manual names out of process-title evidence or they read as the shell reclaiming the pane (#20626).
      const customTitle = title?.trim() || null
      pty.pty.manualTitle = customTitle
      const recordedTabId = (): string | null => this.paneOfPty(pty.pty).tabId
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      const tabIdForTitle = !this.notifier?.renameTerminal ? recordedTabId() : null
      if (tabIdForTitle) {
        this.publishUnrenderedTerminalTitle(pty.pty.worktreeId, tabIdForTitle, customTitle)
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      const tabId = recordedTabId() ?? pty.record.tabId
      // A window without this pane cannot publish the rename for paired clients.
      if (this.notifier?.renameTerminal && tabId) {
        this.publishUnrenderedTerminalTitle(pty.pty.worktreeId, tabId, customTitle)
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  private publishUnrenderedTerminalTitle(
    worktreeId: string,
    tabId: string,
    customTitle: string | null
  ): void {
    this.persistHeadlessTerminalTitle(worktreeId, tabId, customTitle)
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, {
      customTitle,
      ...(customTitle === null
        ? { title: this.headlessTerminalFallbackTitle(worktreeId, tabId) }
        : {})
    })
  }

  /** Names one pane of a split; the tab's own name is untouched. */
  async setPaneTitle(handle: string, title: string | null): Promise<RuntimeTerminalSetPaneTitle> {
    // Switch point: a pane main owns is named in main's layout, with or without a window.
    const mainTitle = ORCA_LAYOUT_OWNER_IS_MAIN
      ? await this.setPaneTitleInMainLayout(handle, title)
      : null
    if (mainTitle) {
      return mainTitle
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!this.hasAuthoritativeWindow() || !this.notifier?.setPaneTitle) {
      throw new Error('Pane titles require a running Orca desktop with set-pane-title support')
    }
    const normalizedTitle = title?.trim() || null
    if (!this.notifier.setPaneTitle(leaf.tabId, leaf.leafId, normalizedTitle)) {
      throw new Error('runtime_unavailable')
    }
    return { handle, tabId: leaf.tabId, leafId: leaf.leafId, title: normalizedTitle }
  }
}
