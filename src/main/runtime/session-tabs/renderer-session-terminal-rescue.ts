import type { OrcaRuntimeWithWaitForLeafPtyId as WaitForLeafPtyIdMethods } from '../terminal/view/renderer-terminal-snapshot'
import { OrcaRuntimeWithWaitForMobileTerminalSurface } from '../terminal/view/mobile-terminal-surface'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-types'
import { worktreeIdsEqual } from '../../../shared/worktree/id'

export abstract class OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals extends OrcaRuntimeWithWaitForMobileTerminalSurface {
  protected abstract resolveHandleForTab(
    ...args: Parameters<WaitForLeafPtyIdMethods['resolveHandleForTab']>
  ): ReturnType<WaitForLeafPtyIdMethods['resolveHandleForTab']>

  protected restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
      const pty = this.ptysById.get(ptyId)
      const recorded = pty?.connected ? this.paneOfPty(pty) : null
      const tabId = recorded?.tabId
      if (
        !pty?.connected ||
        !recorded ||
        !tabId ||
        (worktreeId !== null && !worktreeIdsEqual(pty.worktreeId, worktreeId))
      ) {
        continue
      }
      const targetWorktreeId = worktreeId ?? pty.worktreeId
      const pane = parsePaneKey(recorded.paneKey ?? '')
      if (!pane || pane.tabId !== tabId) {
        continue
      }
      const existing = this.mobileSessionTabsByWorktree.get(targetWorktreeId)
      if (existing && options.missingSnapshotOnly) {
        continue
      }
      if (
        existing?.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            (tab.ptyId === pty.ptyId || (tab.parentTabId === tabId && tab.leafId === pane.leafId))
        )
      ) {
        continue
      }
      if (!existing) {
        this.storeMobileSessionSnapshot(targetWorktreeId, {
          worktree: targetWorktreeId,
          publicationEpoch: `renderer-rescue:${Date.now().toString(36)}`,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabGroups: [],
          tabs: []
        })
      }
      this.publishPtyBackedMobileSessionTerminal(targetWorktreeId, pty, {
        tabId,
        leafId: pane.leafId,
        title: null,
        activate: false,
        selectIfNoActiveTab: false,
        notify: options.notify
      })
    }
  }

  protected setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    if (owned) {
      this.pairedRendererSessionOwnedPtyIds.add(ptyId)
    } else {
      this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    }
  }

  protected findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null {
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId !== worktreeId) {
        continue
      }
      const recorded = this.paneOfPty(pty)
      if (
        recorded.tabId === tabId &&
        pty.connected &&
        parsePaneKey(recorded.paneKey ?? '')?.leafId
      ) {
        return pty
      }
    }
    return null
  }

  // Unregistered-pane shells are still real terminals rollback must not kill (#7718).
  protected hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean {
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktreeId && this.paneOfPty(pty).tabId === tabId && pty.connected) {
        return true
      }
    }
    return false
  }

  protected isReadyMobileTerminalSurface(
    surface: RuntimeMobileSessionCreateTerminalResult | null
  ): boolean {
    return (
      surface?.tab.status === 'ready' &&
      typeof surface.tab.terminal === 'string' &&
      surface.tab.terminal.length > 0
    )
  }

  // A stalled create may leave an agent tab bound to a plain shell (#7587, STA-3214), bypassing pending recovery; absent recorded startup proves it never ran, so deliver it now.
  protected deliverPendingStartupCommandToBareRendererPty(worktreeId: string, tabId: string): void {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    const command = pending?.startupCommand
    if (!command) {
      return
    }
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (!pty || this.terminalSpawnCommandsByPtyId.has(pty.ptyId)) {
      return
    }
    if (this.ptyController?.write(pty.ptyId, command, 'launch')) {
      // Write Enter separately so long commands cannot swallow it.
      this.ptyController.write(pty.ptyId, '\r', 'launch')
      this.noteTerminalSpawnCommand(pty.ptyId, command)
    }
  }

  waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.resolveHandleForTab(tabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal handle after creation'))
      }, timeoutMs)

      const check = (): void => {
        const handle = this.resolveHandleForTab(tabId)
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      // Recheck after registration: graph sync may have already fired.
      check()
    })
  }
}
