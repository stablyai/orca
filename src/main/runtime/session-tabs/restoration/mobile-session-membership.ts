import { tabListOfPty } from '../person/person-workspace-target'
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
import { mobileTerminalTabPaneKey } from '../../session-lifecycle/projection/runtime-mobile-session-projection'
import { structuredAgentSessionIdOfTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
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
    const worktreeId = tabListOfPty({ worktreeId: list.workspaceId, holder: list.holder })
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

  private unplacedStatusLogged = false

  /** The list a hook-reported status row is in, by the stamp on the record any of its keys name: a
   *  chat's (whom it acts for), a terminal's PTY (by handle, host pane, or the teammate surface holding
   *  it), else a host layout pane. Null when none does: an unknown holder is never the host's. */
  getStatusTabList(identity: {
    paneKey: string
    worktreeId?: string
    terminalHandle?: string
  }): TabListRef | null {
    const pane = parsePaneKey(identity.paneKey)
    const sessionId = pane ? structuredAgentSessionIdOfTab(pane.tabId) : null
    const conversation = sessionId
      ? getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
      : undefined
    if (sessionId && conversation) {
      const person = this.chatTabPerson(sessionId)
      return {
        workspaceId: conversation.location.workspaceId,
        holder: person === 'owner' ? undefined : person
      }
    }
    const handlePtyId = identity.terminalHandle
      ? this.getTerminalPtyIdForHandle(identity.terminalHandle)
      : null
    const held = pane
      ? this.personSessionTabs.holderOfSurface(
          (surface) =>
            surface.kind === 'terminal' &&
            surface.parentTabId === pane.tabId &&
            surface.leafId === pane.leafId
        )
      : null
    const pty =
      (handlePtyId ? this.ptysById.get(handlePtyId) : undefined) ??
      this.getPtyRecordForPaneKey(identity.paneKey) ??
      undefined
    if (held && !pty?.holder) {
      return { workspaceId: held.worktreeId, holder: held.person }
    }
    if (pty) {
      return { workspaceId: pty.worktreeId, holder: pty.holder }
    }
    const hostPane = sessionId
      ? null
      : (this.getTerminalWorktreeIdForPaneKey(identity.paneKey) ??
        this.hostSnapshotHoldingPane(identity.paneKey, identity.worktreeId))
    if (hostPane) {
      return { workspaceId: hostPane, holder: undefined }
    }
    if (!this.unplacedStatusLogged) {
      this.unplacedStatusLogged = true
      console.warn(
        '[session-tabs] a status row names no chat, terminal or pane here; no list hears it'
      )
    }
    return null
  }

  /** The workspace whose host session list holds a terminal tab by this pane key (a sleeping or
   *  restored one with no PTY or window pane, or a legacy numeric pane). Held terminals are never in
   *  it (`withOwnSurfacesOnly`). */
  private hostSnapshotHoldingPane(paneKey: string, worktreeId?: string): string | null {
    const candidates = worktreeId ? [worktreeId] : [...this.mobileSessionTabsByWorktree.keys()]
    return (
      candidates.find((candidate) =>
        this.mobileSessionTabsByWorktree
          .get(candidate)
          ?.tabs.some((tab) => tab.type === 'terminal' && mobileTerminalTabPaneKey(tab) === paneKey)
      ) ?? null
    )
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
      tabListOfPty(pty) === worktreeId &&
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
