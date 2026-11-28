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
import type { TabListRef } from '../../../bots/team-share/teammate-rules'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

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

  abstract getTerminalPtyIdForHandle(handle: string): string | null
  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

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
          // Sender scope is carried by the host's snapshot frames alone.
          this.touchSessionTabList({ workspaceId: worktreeId, holder: undefined })
        }
      }
    })
  }

  /** The one touch for a tab list that reads differently. A teammate's own list redraws alone; the
   *  host's bumps snapshotVersion before emitting (coalesced and owed until a client frame unless
   *  immediate), and clients discard re-emits at the same version. */
  touchSessionTabList(list: TabListRef, options: { immediate?: boolean } = {}): void {
    if (list.holder) {
      this.schedulePersonListRedraw(list.holder, list.workspaceId)
      return
    }
    const worktreeId = list.workspaceId
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.observeWorktreeRefresh(worktreeId)
    if (!options.immediate && snapshot.worktree === worktreeId) {
      // Status bursts bump once per client frame, and only build one when someone listens.
      this.mobileSessionTabsByWorktree.oweVersion(worktreeId)
      if (this.mobileSessionTabListeners.size > 0) {
        this.scheduleMobileSessionTabsChanged(worktreeId)
      }
      return
    }
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

  /** Agent status reads stale on a timer, so the host's list refreshes while a hook is alive. A
   *  teammate's terminal row shows no agent status: their list has nothing to refresh. */
  scheduleSessionTabListAgentStatusHeartbeat(list: TabListRef): void {
    if (list.holder || this.mobileSessionTabListeners.size === 0) {
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.scheduleWorktreeHeartbeat(list.workspaceId)
  }

  /** The list a hook-reported terminal is in, from its PTY's stamp; a pane with no PTY record here is
   *  the host's (only a PTY carries a teammate's stamp). */
  getTerminalTabList(identity: {
    paneKey: string
    worktreeId?: string
    terminalHandle?: string
  }): TabListRef | null {
    const ptyId = identity.terminalHandle
      ? this.getTerminalPtyIdForHandle(identity.terminalHandle)
      : null
    const pty =
      (ptyId ? this.ptysById.get(ptyId) : undefined) ??
      this.getPtyRecordForPaneKey(identity.paneKey) ??
      undefined
    const workspaceId =
      identity.worktreeId ??
      pty?.worktreeId ??
      (identity.terminalHandle
        ? this.getTerminalWorktreeIdForHandle(identity.terminalHandle)
        : null) ??
      this.getTerminalWorktreeIdForPaneKey(identity.paneKey)
    return workspaceId ? { workspaceId, holder: pty?.holder } : null
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
