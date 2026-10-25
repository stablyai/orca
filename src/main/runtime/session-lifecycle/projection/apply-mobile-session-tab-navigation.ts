import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as MobileSessionPublication } from '../../session-tabs/session-tabs-change-publication'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as MobileSessionPreservation } from '../../session-tabs/mobile-session-publication-preservation'
import { OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh } from './perform-mobile-session-pty-records-refresh'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { navigationTargetsClients } from '../../../../shared/runtime-navigation'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from '../../client-session-tab-selection-projection'
import {
  buildHeadlessMobileSessionTabGroups,
  cloneTerminalLayoutSnapshot
} from '../../mobile-session-layout-projection'

export abstract class OrcaRuntimeWithApplyMobileSessionTabNavigation extends OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh {
  protected abstract emitMobileSessionTabsSnapshotToClient(
    ...args: Parameters<MobileSessionPublication['emitMobileSessionTabsSnapshotToClient']>
  ): ReturnType<MobileSessionPublication['emitMobileSessionTabsSnapshotToClient']>
  protected abstract isHeadlessMobileSessionPublication(
    ...args: Parameters<MobileSessionPreservation['isHeadlessMobileSessionPublication']>
  ): ReturnType<MobileSessionPreservation['isHeadlessMobileSessionPublication']>

  protected applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    let callerSnapshot: RuntimeMobileSessionTabsResult | null = null
    if (navigationTargetsClients(navigation)) {
      // Follow is live intent; reconnecting devices must not inherit stale navigation.
      const ids = new Set(
        [...this.mobileSessionTabListeners]
          .map((subscription) => subscription.clientNavigationId)
          .filter((id): id is string => Boolean(id))
      )
      if (clientNavigationId) {
        ids.add(clientNavigationId)
      }
      for (const id of ids) {
        const projected = this.clientSessionTabSelections.activate(
          this.withSessionTabsHolds(snapshot, id),
          id,
          activeTabId
        )
        this.emitMobileSessionTabsSnapshotToClient(projected, id, true)
        if (id === clientNavigationId) {
          callerSnapshot = projected
        }
      }
    } else if (clientNavigationId) {
      // Follow-host adds the host as a target without replacing caller navigation.
      callerSnapshot = this.clientSessionTabSelections.activate(
        this.withSessionTabsHolds(snapshot, clientNavigationId),
        clientNavigationId,
        activeTabId
      )
      this.emitMobileSessionTabsSnapshotToClient(callerSnapshot, clientNavigationId)
    }
    if (clientNavigationId) {
      return callerSnapshot ?? this.projectMobileSessionTabsForClient(snapshot, clientNavigationId)
    }
    if (navigation === 'caller') {
      const selection = activateClientSessionTabSelection(
        snapshot,
        deriveClientSessionTabSelection(snapshot),
        activeTabId
      )
      return projectClientSessionTabSelection(snapshot, selection).snapshot
    }
    return snapshot
  }

  /** Select a newly created tab for one client; false if absent. Unlike a tap, this never wakes or respawns a pending pane. */
  selectCreatedMobileSessionTabForClient(
    worktreeId: string,
    surface: { tabId: string; leafId: string } | { sessionId: string },
    clientNavigationId: string
  ): boolean {
    const snapshot = this.getMobileSessionTabsForWorktree(worktreeId)
    const tab = snapshot.tabs.find((candidate) =>
      'sessionId' in surface
        ? candidate.type === 'agent-session' && candidate.sessionId === surface.sessionId
        : candidate.type === 'terminal' &&
          candidate.parentTabId === surface.tabId &&
          candidate.leafId === surface.leafId
    )
    if (!tab) {
      return false
    }
    this.applyMobileSessionTabNavigation(snapshot, tab.id, 'caller', clientNavigationId)
    return true
  }

  protected shouldMaterializeHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return (
      this.isHeadlessMobileSessionPublication(snapshot.publicationEpoch) ||
      this.hasServeOrSshOwnedBinding(tab)
    )
  }

  protected shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (snapshot.publicationEpoch.includes(':headless-merge:')) {
      return false
    }
    if (this.authoritativeWindowId !== null && this.graphStatus === 'ready') {
      return false
    }
    return this.shouldMaterializeHeadlessMobileSessionTab(snapshot, tab)
  }

  protected activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionTerminalTab
  ): void {
    const tabs = snapshot.tabs.map((candidate) => ({
      ...candidate,
      isActive: candidate.id === activeTab.id
    }))
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: activeTab.id,
      activeTabType: 'terminal',
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activeTab,
        snapshot.tabGroups
      ),
      tabs
    }
    this.persistHeadlessTerminalActiveLeaf(worktreeId, activeTab)
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  protected persistHeadlessTerminalActiveLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const existingLayout = session.terminalLayoutsByTabId?.[tab.parentTabId]
    const nextLayouts = existingLayout
      ? {
          ...session.terminalLayoutsByTabId,
          [tab.parentTabId]: {
            ...cloneTerminalLayoutSnapshot(existingLayout),
            activeLeafId: tab.leafId
          }
        }
      : session.terminalLayoutsByTabId
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      activeTabId: tab.parentTabId,
      activeTabIdByWorktree: {
        ...session.activeTabIdByWorktree,
        [worktreeId]: tab.parentTabId
      },
      terminalLayoutsByTabId: nextLayouts
    })
  }
}
