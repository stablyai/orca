import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import type { OrcaRuntimeWithGetTerminalInteractiveWait as GetTerminalInteractiveWaitMethods } from '../terminal/wait/terminal-interactive-wait'
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './pty-backed-session-publication'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { hasHostAuthoritativeTerminalMembership } from '../../persistence/terminal-topology/terminal-topology-membership'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from '../mobile-session-terminal-retirement'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'

export abstract class OrcaRuntimeWithTouchMobileSessionTabsForWorktree extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  abstract getTerminalWorktreeIdForPaneKey(
    ...args: Parameters<GetTerminalInteractiveWaitMethods['getTerminalWorktreeIdForPaneKey']>
  ): ReturnType<GetTerminalInteractiveWaitMethods['getTerminalWorktreeIdForPaneKey']>

  /** A hook names its pane's conversation; sender bookkeeping never fails the hook. */
  setAgentSenderPeerKey(read: () => string | null): void {
    this.agentProjections.setPeerKey(read)
  }

  observeAgentSenderHook(event: EnrichedAgentHookEventPayload, dispatchId: string | null): void {
    const agent = event.payload.agentType
    const session = event.providerSession?.id
    if (event.structuredHost || !agent || !session) {
      return
    }
    try {
      this.agentProjections.senders.observeHook(this.getOrchestrationDbIfAvailable(), {
        paneKey: event.paneKey,
        agent,
        session,
        process: event.agentPresence?.process,
        dispatchId
      })
    } catch (error) {
      console.warn('[runtime] Sender conversation observation failed', error)
    }
  }

  /** Republish only worktrees whose sender scope differs from the one their last frame carried. */
  refreshAgentSenderAssociations(): void {
    const changed = this.agentProjections.senders.changedScopes(
      this.mobileSessionTabsByWorktree.keys()
    )
    for (const worktreeId of changed) {
      this.touchMobileSessionTabsForWorktree(worktreeId)
    }
  }

  /** Bump snapshotVersion before emitting (coalesced unless immediate); clients discard re-emits at the same version. */
  touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options: { immediate?: boolean } = {}
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
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

  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void {
    if (this.mobileSessionTabListeners.size === 0) {
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
