import type { MobileSessionTabSubscription } from '../../construction/runtime-identity-state'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as SessionTabsPublication } from '../publication/session-tabs-change-publication'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as SessionTabsProjection } from '../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithGetTerminalInteractiveWait as GetTerminalInteractiveWaitMethods } from '../../terminal/wait/terminal-interactive-wait'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from '../publication/pty-backed-session-publication'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { hasHostAuthoritativeTerminalMembership } from '../../../persistence/terminal-topology/pane-ownership/terminal-topology-membership'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { retireTerminalSurfacesFromSnapshot } from '../../terminal/surface/mobile-session-terminal-retirement'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import { touchMobileSessionStatus } from './mobile-session-status-touch'

export abstract class OrcaRuntimeWithTouchMobileSessionTabsForWorktree extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  protected abstract createMobileSessionTabsDelivery(): ReturnType<
    SessionTabsPublication['createMobileSessionTabsDelivery']
  >

  protected abstract toMobileSessionTabsResult(
    ...args: Parameters<SessionTabsProjection['toMobileSessionTabsResult']>
  ): ReturnType<SessionTabsProjection['toMobileSessionTabsResult']>

  protected abstract selectMobileSessionTabsListeners(
    worktree?: string,
    clientNavigationId?: string,
    candidates?: Iterable<MobileSessionTabSubscription>
  ): MobileSessionTabSubscription[]

  protected abstract hasPaneStatusListeners(paneKey: string): boolean

  abstract getTerminalWorktreeIdForPaneKey(
    ...args: Parameters<GetTerminalInteractiveWaitMethods['getTerminalWorktreeIdForPaneKey']>
  ): ReturnType<GetTerminalInteractiveWaitMethods['getTerminalWorktreeIdForPaneKey']>

  /** The RPC server owns the pairing key clients authenticate this host by. */
  setAgentSenderPeerKey(read: () => string | null): void {
    this.agentProjections.setPeerKey(read)
  }

  /** Republish only worktrees whose sender scope differs from the one their last frame carried. */
  async refreshAgentSenderAssociations(): Promise<void> {
    const listeners = this.selectMobileSessionTabsListeners().filter(
      (subscription) => subscription.clientKind !== 'mobile'
    )
    if (listeners.length === 0) {
      return
    }
    await this.agentProjections.senders.withPreparedPublication(() => {
      const changed = this.agentProjections.senders.changedScopes(
        this.mobileSessionTabsByWorktree.keys()
      )
      for (const worktreeId of changed) {
        if (this.selectMobileSessionTabsListeners(worktreeId, undefined, listeners).length > 0) {
          this.touchMobileSessionTabsForWorktree(worktreeId)
        }
      }
    })
  }

  /** Bump snapshotVersion before emitting (coalesced and owed until a client frame unless immediate); clients discard re-emits at the same version. */
  touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options: { immediate?: boolean; statusPaneKeys?: readonly string[] } = {}
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    if (!options.immediate && snapshot.worktree === worktreeId) {
      const listened = options.statusPaneKeys
        ? options.statusPaneKeys.some((paneKey) => this.hasPaneStatusListeners(paneKey))
        : this.mobileSessionTabListeners.size > 0
      touchMobileSessionStatus(worktreeId, listened, {
        heartbeat: this.mobileSessionTabsAgentStatusHeartbeat,
        snapshots: this.mobileSessionTabsByWorktree,
        schedule: (id) => this.scheduleMobileSessionTabsChanged(id)
      })
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.observeWorktreeRefresh(worktreeId)
    this.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1
    })
    if (options.immediate) {
      // Emit structural exits immediately; coalesce ready flips with spawn graph updates.
      this.notifyMobileSessionTabsChanged(worktreeId)
      return
    }
    // Coalesce spinner-driven title/status bursts instead of broadcasting every version.
    this.scheduleMobileSessionTabsChanged(worktreeId)
  }

  /** Pays a deferred status bump before a stored snapshot is projected: at most one store per owed bump. */
  protected settleOwedMobileSessionSnapshotVersion(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const worktreeId = snapshot.worktree
    if (this.mobileSessionTabsByWorktree.get(worktreeId) !== snapshot) {
      return snapshot
    }
    return (
      this.mobileSessionTabsByWorktree.payOwedVersion(worktreeId, () =>
        this.storeMobileSessionSnapshot(worktreeId, {
          ...snapshot,
          snapshotVersion: snapshot.snapshotVersion + 1
        })
      ) ?? snapshot
    )
  }

  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(
    worktreeId: string,
    paneKey?: string
  ): void {
    if (
      paneKey === undefined
        ? this.mobileSessionTabListeners.size === 0
        : !this.hasPaneStatusListeners(paneKey)
    ) {
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.scheduleWorktreeHeartbeat(worktreeId)
  }

  /** Republish the workspace snapshot after a pane's hook status changed.
   *  Hook rows feed the headless `agentStatus` projection, which nothing else touches. */
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void {
    const resolved = worktreeId ?? this.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!resolved) {
      return
    }
    this.touchMobileSessionTabsForWorktree(resolved)
  }

  protected mobileSessionSnapshotHasSurface(
    worktreeId: string,
    parentTabId: string,
    leafId: string
  ): boolean {
    return Boolean(
      this.mobileSessionTabsByWorktree
        .get(worktreeId)
        ?.tabs.some(
          (tab) =>
            tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
        )
    )
  }

  protected isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    // Only absent sessions license membership; normalize partition misses to undefined.
    const session = this.getWorkspaceSessionForWorktree(worktreeId) ?? undefined
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (
      !hasHostAuthoritativeTerminalMembership(session, worktreeId) &&
      (session !== undefined || !this.terminalTopologyRevisionByRepoId.has(repoId))
    ) {
      return true
    }
    if (this.mobileSessionSnapshotHasSurface(worktreeId, parentTabId, leafId)) {
      return true
    }
    if (!candidatePtyId) {
      return false
    }
    const pty = this.ptysById.get(candidatePtyId)
    const recorded = this.paneOfPty(pty)
    const pane = parsePaneKey(recorded.paneKey ?? '')
    return Boolean(
      pty?.connected &&
      pty.worktreeId === worktreeId &&
      recorded.tabId === parentTabId &&
      pane?.leafId === leafId
    )
  }

  protected reconcileMobileSessionRetirementFences(
    leaves: readonly RuntimeSyncedLeaf[]
  ): RuntimeSyncedLeaf[] {
    const mainOwns = ORCA_LAYOUT_OWNER_IS_MAIN
      ? startedMainTerminalSurfaces(this)?.ownedWorkspaces()
      : null
    return leaves.filter(
      (leaf) =>
        mainOwns?.has(leaf.worktreeId) ||
        this.isMobileSessionSurfaceMembershipAllowed(
          leaf.worktreeId,
          leaf.tabId,
          leaf.leafId,
          leaf.ptyId
        )
    )
  }

  protected applyMobileSessionRetirementFences(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    let next = snapshot
    for (const tab of snapshot.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.isMobileSessionSurfaceMembershipAllowed(
          snapshot.worktree,
          tab.parentTabId,
          tab.leafId,
          tab.ptyId
        ) ||
        // Before PTY registration, cold restore has only saved membership; use it for the frame until surface graph leaves qualify.
        this.hasPersistedTerminalSurfaceMembership(snapshot.worktree, tab.parentTabId, tab.leafId)
      ) {
        continue
      }
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot: next,
        ptyId: tab.ptyId ?? '',
        exactSurfaces: [{ parentTabId: tab.parentTabId, leafId: tab.leafId }],
        exactOnly: true
      })
      if (retired) {
        next = retired.snapshot
      }
    }
    return next
  }
}
