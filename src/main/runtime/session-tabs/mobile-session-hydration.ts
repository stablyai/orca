import {
  detachMobileSessionTerminalValues,
  isOwnedMobileSessionSource,
  savedMobileSessionNavigation,
  registeredSessionWorkspaces
} from './mobile-session-persisted-inputs'
import { borrowWorkspaceSession } from '../../persistence/loading-store/workspace-sessions/session-host-partitions'
import {
  normalizeMobileSessionTabSelection,
  restoreLegacyMobileSessionNavigation
} from './mobile-session-tab-selection'
import type { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs as BuildHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/build-headless-mobile-session-browser-tabs'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import type { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs as ReconcileHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'
import type { BrowserWindow } from 'electron'
import { RuntimeSessionTabsInventoryPublication } from './session-tabs-inventory-publication'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getRuntimeBrowserPageRegistry } from '../browser/client-pages/runtime-browser-page-registry'
import { buildHeadlessMobileSessionTerminalTabs } from '../terminal/surface/mobile-session-terminal-projection'
import { buildHeadlessMobileSessionEditorTabs } from './headless-editor-tabs'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import {
  collectHeadlessParentTabOrder,
  getHeadlessMobileSessionGroupId,
  pickHeadlessActiveTerminalTab,
  pickRestoredActiveGroupId
} from '../terminal/surface/mobile-session-layout-projection'
import {
  appendChatTabOrder,
  keepSnapshotChatTabs,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../session-lifecycle/projection/mobile-session-tab-merge'
import { appendBrowserTabOrder } from '../session-lifecycle/projection/mobile-session-browser-group-projection'
import { headlessMobileSnapshotContentUnchanged } from './mobile-session-snapshot-equality'

export abstract class OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession extends RuntimeSessionTabsInventoryPublication {
  protected abstract buildHeadlessMobileSessionBrowserTabs(
    ...args: Parameters<
      BuildHeadlessMobileSessionBrowserTabsMethods['buildHeadlessMobileSessionBrowserTabs']
    >
  ): ReturnType<
    BuildHeadlessMobileSessionBrowserTabsMethods['buildHeadlessMobileSessionBrowserTabs']
  >

  protected abstract getMergedMobileSessionPublicationEpoch(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['getMergedMobileSessionPublicationEpoch']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['getMergedMobileSessionPublicationEpoch']
  >

  protected abstract hasRecentExpiredSshLeasePane(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['hasRecentExpiredSshLeasePane']
    >
  ): ReturnType<ReconcileHeadlessMobileSessionBrowserTabsMethods['hasRecentExpiredSshLeasePane']>

  protected abstract hasServeOrSshOwnedBinding(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['hasServeOrSshOwnedBinding']
    >
  ): ReturnType<ReconcileHeadlessMobileSessionBrowserTabsMethods['hasServeOrSshOwnedBinding']>

  protected abstract isHeadlessBuiltMobileSessionPublicationBase(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['isHeadlessBuiltMobileSessionPublicationBase']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['isHeadlessBuiltMobileSessionPublicationBase']
  >

  protected abstract reconcileHeadlessMobileSessionBrowserTabs(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['reconcileHeadlessMobileSessionBrowserTabs']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['reconcileHeadlessMobileSessionBrowserTabs']
  >

  protected abstract workspaceSessionHasRuntimeOwnedPtyCandidate(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionHasRuntimeOwnedPtyCandidate']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionHasRuntimeOwnedPtyCandidate']
  >

  protected abstract workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    ...args: Parameters<
      ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
    >
  ): ReturnType<
    ReconcileHeadlessMobileSessionBrowserTabsMethods['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
  >

  protected abstract getAvailableAuthoritativeWindow(): BrowserWindow | null

  /** A stored snapshot, or undefined when it is one this host built and left empty. */
  private readRebuildableMobileSessionSnapshot(
    worktreeId: string
  ): RuntimeMobileSessionTabsSnapshot | undefined {
    const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
    // Empty headless-built snapshots cannot seed refreshes or browser-only rebuilds hide every terminal.
    return stored &&
      stored.tabs.length === 0 &&
      this.isHeadlessBuiltMobileSessionPublicationBase(stored.publicationEpoch)
      ? undefined
      : stored
  }

  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    } = {}
  ): Set<string> {
    // Report in-place reconciliations so callers avoid repeating them.
    const reconciledWorktreeIds = new Set<string>()
    const hasAuthoritativeWindow = Boolean(this.getAvailableAuthoritativeWindow())
    if (hasAuthoritativeWindow && options.allowAttachedWindow !== true) {
      return reconciledWorktreeIds
    }
    const session =
      options.workspaceSession ??
      (worktreeId
        ? this.borrowWorkspaceSessionForWorktree(worktreeId)
        : borrowWorkspaceSession(this.store))
    if (!session) {
      return reconciledWorktreeIds
    }
    const owned = isOwnedMobileSessionSource(
      this.workspaceSessions,
      this.store,
      worktreeId,
      session
    )
    // Runtime-only hydration without owned terminals/offscreen backend always yields zero rows; skip per-workspace rebuilds on graph sync.
    if (
      options.onlyRuntimeOwnedTerminals === true &&
      !this.offscreenBrowserBackend &&
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId ?? '').length === 0 &&
      options.runtimeOwnedTerminalCandidateKnown !== true &&
      !(worktreeId
        ? this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
            session,
            worktreeId,
            session.tabsByWorktree[worktreeId] ?? []
          )
        : this.workspaceSessionHasRuntimeOwnedPtyCandidate(session))
    ) {
      return reconciledWorktreeIds
    }
    // A worktree whose only tabs are editors has no tabsByWorktree key.
    const entries =
      worktreeId !== undefined
        ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
        : [
            ...new Set([
              ...Object.keys(session.tabsByWorktree ?? {}),
              ...Object.keys(session.openFilesByWorktree ?? {}),
              ...Object.keys(session.tabGroups ?? {})
            ])
          ].map((id) => [id, session.tabsByWorktree?.[id] ?? []] as const)
    for (const [entryWorktreeId, persistedTabs] of registeredSessionWorkspaces(
      entries,
      this.store
    )) {
      const stored = this.readRebuildableMobileSessionSnapshot(entryWorktreeId)
      if (
        stored &&
        stored.tabs.length > 0 &&
        options.force !== true &&
        options.onlyRuntimeOwnedTerminals !== true
      ) {
        // Terminal rows are stable; refresh only live browser rows to capture creates/closes without rebuilding terminals.
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, stored)
        reconciledWorktreeIds.add(entryWorktreeId)
        // Rebuild immediately after the last browser closes instead of serving one empty browser-only snapshot.
        if (this.readRebuildableMobileSessionSnapshot(entryWorktreeId)) {
          continue
        }
      }
      const existing = this.readRebuildableMobileSessionSnapshot(entryWorktreeId)
      const currentNavigation = this.mobileSessionTabsByWorktree.get(entryWorktreeId)
      // Windowless hosts have no other row publisher; a filtered seed would suppress the full rebuild.
      const runtimeOwnedOnly =
        options.onlyRuntimeOwnedTerminals === true &&
        (existing !== undefined || hasAuthoritativeWindow)
      const terminalTabs = detachMobileSessionTerminalValues(
        buildHeadlessMobileSessionTerminalTabs(
          entryWorktreeId,
          persistedTabs,
          session,
          this.store?.getSettings?.()?.tabAutoGenerateTitle === true
        ),
        owned
      ).filter(
        (tab) =>
          !runtimeOwnedOnly ||
          this.hasServeOrSshOwnedBinding(tab) ||
          this.hasRecentExpiredSshLeasePane(entryWorktreeId, tab)
      )
      // Always include offscreen browsers; the runtime-only filter limits PTY ownership, not browser rows.
      const browserTabs = this.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      // Runtime-only merges inherit renderer editors instead of publishing their own.
      const editorTabs = runtimeOwnedOnly
        ? []
        : buildHeadlessMobileSessionEditorTabs(entryWorktreeId, session)
      const tabs: RuntimeMobileSessionSnapshotTab[] = [
        ...terminalTabs,
        ...editorTabs,
        ...browserTabs
      ]
      if (
        tabs.length === 0 &&
        currentNavigation?.tabGroups === undefined &&
        !session.tabGroups?.[entryWorktreeId]?.length
      ) {
        continue
      }
      const activeTab = pickHeadlessActiveTerminalTab(terminalTabs)
      const tabOrder = [
        ...collectHeadlessParentTabOrder(terminalTabs),
        ...editorTabs.map((tab) => tab.id),
        ...browserTabs.map((tab) => tab.id)
      ]
      const groupId = getHeadlessMobileSessionGroupId(entryWorktreeId)
      const mergedTabs =
        options.onlyRuntimeOwnedTerminals === true && existing
          ? mergeMobileSessionSnapshotTabs(existing.tabs, tabs)
          : keepSnapshotChatTabs(tabs, existing)
      const mergedActiveTab =
        existing?.tabs.find((tab) => tab.id === existing.activeTabId) ??
        activeTab ??
        editorTabs.find((tab) => tab.isActive) ??
        mergedTabs[0] ??
        null
      // Editors ride with browsers: both keep their persisted group, unlike terminal parents.
      const mergedBrowserOrder = mergedTabs
        .filter((tab) => tab.type === 'browser' || tab.type === 'markdown' || tab.type === 'file')
        .map((tab) => tab.id)
      // Restore persisted split groups or cold rebuilds coalesce them into one.
      const hasCurrentNavigation = currentNavigation?.tabGroups !== undefined
      const persisted = savedMobileSessionNavigation(session, entryWorktreeId, owned)
      const persistedGroups = persisted.groups
      const navigationGroups = hasCurrentNavigation ? currentNavigation.tabGroups : persistedGroups
      const navigationLayout = hasCurrentNavigation
        ? currentNavigation.tabGroupLayout
        : persisted.layout
      const navigationActiveGroupId = hasCurrentNavigation
        ? currentNavigation.activeGroupId
        : session.activeGroupIdByWorktree?.[entryWorktreeId]
      const activeTopLevelId = mergedActiveTab
        ? mergedActiveTab.type === 'terminal'
          ? mergedActiveTab.parentTabId
          : mergedActiveTab.id
        : null
      // Saved groups without a saved active group record no selection; keep the restored tab selected.
      const restoredGroups =
        hasCurrentNavigation || navigationActiveGroupId || !activeTopLevelId
          ? navigationGroups
          : navigationGroups?.map((group) =>
              group.activeTabId === null && group.tabOrder.includes(activeTopLevelId)
                ? { ...group, activeTabId: activeTopLevelId }
                : group
            )
      const rebuiltTabGroups: RuntimeMobileSessionTabGroup[] = restoredGroups
        ? appendBrowserTabOrder(
            mergeMobileSessionTabGroups(
              entryWorktreeId,
              restoredGroups,
              mergedTabs,
              mergedActiveTab?.type === 'terminal' ? mergedActiveTab : null,
              persistedGroups
            ),
            mergedBrowserOrder
          )
        : [{ id: groupId, activeTabId: activeTopLevelId ?? tabOrder[0] ?? null, tabOrder }]
      const nextTabGroups = appendChatTabOrder(rebuiltTabGroups, existing?.tabGroups, mergedTabs)
      // Keep renderer base epochs when merging runtime rows, or preservation misclassifies renderer tabs as runtime-owned and resurrects closed tabs.
      const mergedIntoRendererPublication =
        options.onlyRuntimeOwnedTerminals === true &&
        existing !== undefined &&
        !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
      const rebuiltSnapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: existing?.worktree ?? entryWorktreeId,
        publicationEpoch: mergedIntoRendererPublication
          ? this.getMergedMobileSessionPublicationEpoch(existing, tabs)
          : `headless-hydrated:${Date.now().toString(36)}`,
        snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
        activeGroupId: hasCurrentNavigation
          ? currentNavigation.activeGroupId
          : pickRestoredActiveGroupId(nextTabGroups, [navigationActiveGroupId], activeTopLevelId),
        activeTabId: existing?.activeTabId ?? mergedActiveTab?.id ?? null,
        activeTabType: mergedActiveTab?.type ?? null,
        tabGroups: nextTabGroups,
        // Group navigation and topology must come from the same publication.
        ...(navigationLayout !== undefined ? { tabGroupLayout: navigationLayout } : {}),
        tabs: mergedTabs
      }
      const nextSnapshot =
        currentNavigation && !hasCurrentNavigation
          ? restoreLegacyMobileSessionNavigation(rebuiltSnapshot, currentNavigation)
          : normalizeMobileSessionTabSelection(rebuiltSnapshot)
      // Retain the existing object and version for equal projections so unchanged graph syncs do not fan out.
      if (
        currentNavigation &&
        headlessMobileSnapshotContentUnchanged(currentNavigation, nextSnapshot)
      ) {
        continue
      }
      this.storeMobileSessionSnapshot(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }
}
