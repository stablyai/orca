// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs } from './orca-runtime-reconcile-headless-mobile-session-browser-tabs'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { SSH_PANE_RECOVERY_GRACE_MS } from './orca-runtime-core'

export class OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding extends OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs {
  // Why: a snapshot tab can keep a serve/SSH-owned ptyId after the runtime
  // terminal died and was de-persisted, so id shape alone must not preserve it
  // against a renderer publication. Require the binding to be backed by a live
  // PTY or by the persisted workspace session (a dormant persisted serve/SSH
  // binding is still re-hydratable, so it stays preserved).
  protected hasLiveOrPersistedServeOrSshOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const boundPtyIds = [
      tab.ptyId,
      ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})
    ].filter((ptyId): ptyId is string => this.isServeOrSshOwnedPtyId(ptyId))
    const boundSshPtyIds = boundPtyIds.filter((ptyId) => this.isSshOwnedPtyId(ptyId))
    if (boundPtyIds.length === 0) {
      return this.hasRecentExpiredSshLeasePane(worktreeId, tab)
    }
    // Why: exited PTY records are archived in ptysById, so require a connected
    // record — a dead serve shell whose persisted binding is also gone must
    // stop being preserved.
    if (boundPtyIds.some((ptyId) => this.ptysById.get(ptyId)?.connected === true)) {
      return true
    }
    const now = Date.now()
    if (
      boundPtyIds.some((ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return (
          pty?.connectionId != null &&
          pty.lastExitCode != null &&
          pty.lastExitCode < 0 &&
          pty.disconnectedAt != null &&
          now - pty.disconnectedAt <= SSH_PANE_RECOVERY_GRACE_MS
        )
      })
    ) {
      // Why: an abnormal SSH transport exit can beat paired-viewer recovery; retain its pane briefly so the HUB remains addressable.
      return true
    }
    if (
      now - this.startedAt <= SSH_PANE_RECOVERY_GRACE_MS &&
      boundSshPtyIds.some((ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return !pty || (!pty.connected && pty.lastExitCode === null)
      })
    ) {
      // Why: after a HUB restart, failed SSH reattach can remove persistence before the fresh runtime records an exit; keep the pane reachable for ensure.
      return true
    }
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return false
    }
    const persistedTab = (session.tabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id === tab.parentTabId
    )
    if (!persistedTab) {
      return false
    }
    const persistedPtyIds = new Set(
      [
        persistedTab.ptyId,
        ...Object.values(session.terminalLayoutsByTabId?.[persistedTab.id]?.ptyIdsByLeafId ?? {})
      ].filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
    return boundPtyIds.some((ptyId) => persistedPtyIds.has(ptyId))
  }

  protected hasLiveRuntimeSessionOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    return pty?.connected === true && pty.runtimeSessionOwned
  }

  protected clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string
  ): void {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal' || tab.parentTabId !== parentTabId) {
        continue
      }
      const ptyIds = [tab.ptyId, ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})].filter(
        (ptyId): ptyId is string => typeof ptyId === 'string'
      )
      for (const ptyId of ptyIds) {
        const pty = this.ptysById.get(ptyId)
        if (pty?.worktreeId === worktreeId && pty.tabId === parentTabId) {
          pty.runtimeSessionOwned = false
          this.setPairedRendererSessionOwnership(pty.ptyId, false)
        }
      }
    }
  }

  // Why: a tab needs authoritative runtime teardown (kill + de-persist + prune)
  // only when the renderer can't durably tear it down: either it's serve/SSH
  // (preserved + re-hydrated, would resurrect) or the renderer graph never
  // published it (a leaked/unadopted shell — incl. daemon-session `@@` tabs the
  // host materialized but the renderer never showed). A tab the renderer graph
  // DOES list — including an ordinary daemon-backed local terminal or a pending
  // tab whose PTY hasn't bound — is renderer-owned: delegate, do not de-persist.
  protected isRuntimeOwnedHeadlessMobileTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (this.hasServeOrSshOwnedBinding(tab)) {
      return true
    }
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (pty && this.isServeOrSshOwnedPtyId(pty.ptyId)) {
      return true
    }
    return !this.tabs.has(tab.parentTabId)
  }
}
