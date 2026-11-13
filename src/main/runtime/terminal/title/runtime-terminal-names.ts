import type {
  RuntimeTerminalRename,
  RuntimeTerminalSetPaneTitle
} from '../../../../shared/runtime-terminal-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { RuntimeNestedWorktreeRemoval } from '../../workspaces/removal/runtime-nested-worktree-removal'

export abstract class RuntimeTerminalNames extends RuntimeNestedWorktreeRemoval {
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
        this.publishManualTerminalTitle(pty.pty.worktreeId, tabIdForTitle, title)
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
        // No window pane holds this terminal, so paired clients only learn the name from this row.
        this.publishManualTerminalTitle(pty.pty.worktreeId, tabId, title, {
          keepPublicationEpoch: true
        })
        this.notifier.renameTerminal(tabId, title)
      }
      return { handle, tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  // Publish manual titles: paired desktops prefer saved-session names over live titles (#29975).
  private publishManualTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null,
    options?: { keepPublicationEpoch: true }
  ): void {
    const customTitle = title?.trim() || null
    this.applyHeadlessSessionTabPropsToSnapshot(
      worktreeId,
      tabId,
      {
        customTitle,
        // Reset must also drop a name saved while sleeping.
        ...(customTitle === null
          ? { title: this.headlessTerminalFallbackTitle(worktreeId, tabId) }
          : {})
      },
      options
    )
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
