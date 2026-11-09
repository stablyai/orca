import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../../shared/runtime-terminal-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithRemoveManagedWorktree } from '../../workspaces/removal/workspace-removal'

export abstract class RuntimeTerminalNames extends OrcaRuntimeWithRemoveManagedWorktree {
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
      pty.pty.manualTitle = title?.trim() || null
      const recordedTabId = (): string | null => this.paneOfPty(pty.pty).tabId
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Persist headless custom titles so restart cannot lose a rename.
      const tabIdForTitle = !this.notifier?.renameTerminal ? recordedTabId() : null
      if (tabIdForTitle) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabIdForTitle, title)
        // Publish manual titles: paired desktops prefer saved-session names over live titles (#29975).
        const customTitle = title?.trim() || null
        this.applyHeadlessSessionTabPropsToSnapshot(pty.pty.worktreeId, tabIdForTitle, {
          customTitle,
          // Reset must also drop a name saved while sleeping.
          ...(customTitle === null
            ? {
                title: this.headlessTerminalFallbackTitle(pty.pty.worktreeId, tabIdForTitle)
              }
            : {})
        })
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      const tabId = recordedTabId() ?? pty.record.tabId
      // A notifier can exist before its pane graph; retain the rename on the known tab.
      if (this.notifier?.renameTerminal && tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, tabId, title)
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
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
    if (!this.getAvailableAuthoritativeWindow() || !this.notifier?.setPaneTitle) {
      throw new Error('Pane titles require a running Orca desktop with set-pane-title support')
    }
    const normalizedTitle = title?.trim() || null
    if (!this.notifier.setPaneTitle(leaf.tabId, leaf.leafId, normalizedTitle)) {
      throw new Error('runtime_unavailable')
    }
    return { handle, tabId: leaf.tabId, leafId: leaf.leafId, title: normalizedTitle }
  }
}
