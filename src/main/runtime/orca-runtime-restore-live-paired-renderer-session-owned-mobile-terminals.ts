// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWaitForMobileTerminalSurface } from './orca-runtime-wait-for-mobile-terminal-surface'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'

export class OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals extends OrcaRuntimeWithWaitForMobileTerminalSurface {
  protected restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
      const pty = this.ptysById.get(ptyId)
      if (
        !pty?.connected ||
        !pty.tabId ||
        (worktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId))
      ) {
        continue
      }
      const targetWorktreeId = worktreeId ?? pty.worktreeId
      const pane = parsePaneKey(pty.paneKey ?? '')
      if (!pane || pane.tabId !== pty.tabId) {
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
            (tab.ptyId === pty.ptyId ||
              (tab.parentTabId === pty.tabId && tab.leafId === pane.leafId))
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
        tabId: pty.tabId,
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
      if (
        pty.worktreeId === worktreeId &&
        pty.tabId === tabId &&
        pty.connected &&
        parsePaneKey(pty.paneKey ?? '')?.leafId
      ) {
        return pty
      }
    }
    return null
  }

  // Why: looser rollback guard than findLiveRegisteredPtyForRendererTab — a shell without a registered pane key is still a real terminal the timeout must not kill (#7718).
  protected hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean {
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktreeId && pty.tabId === tabId && pty.connected) {
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

  // Why: a create can settle over a renderer PTY that spawned without its
  // startup command (the create's renderer stalled, #7587), silently binding
  // the client to a plain shell under an agent tab forever — once the surface
  // is ready, the activation-time materialize recovery (#7837) never runs
  // (STA-3214). Spawn commands are recorded per PTY at spawn time, so a
  // missing record on the locally registered live PTY proves the launch never
  // ran; type it into the shell like the create would have.
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
    if (this.ptyController?.write(pty.ptyId, command)) {
      // Why: Enter rides its own write so a long command cannot swallow it.
      this.ptyController.write(pty.ptyId, '\r')
      this.noteTerminalSpawnCommand(pty.ptyId, command)
    }
  }

  protected waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
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
      // Why: graph sync may have fired between the initial check and registration; re-check to avoid a missed wake-up.
      check()
    })
  }
}
