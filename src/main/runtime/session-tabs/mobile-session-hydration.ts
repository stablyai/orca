import type { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs as BuildHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/build-headless-mobile-session-browser-tabs'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import type { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs as ReconcileHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'
import type { BrowserWindow } from 'electron'
import { RuntimeSessionTabsInventoryPublication } from './session-tabs-inventory-publication'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { buildHeadlessMobileSessionTerminalTabs } from '../mobile-session-terminal-projection'
import { buildHeadlessMobileSessionEditorTabs } from '../mobile-session-editor-projection'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import {
  collectHeadlessParentTabOrder,
  distributeHeadlessTabsAcrossGroups,
  getHeadlessMobileSessionGroupId,
  pickHeadlessActiveTerminalTab,
  pickRestoredActiveGroupId
} from '../mobile-session-layout-projection'
import {
  appendChatTabOrder,
  keepSnapshotChatTabs,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../mobile-session-tab-merge'
import {
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from '../mobile-session-browser-group-projection'
import { headlessMobileSnapshotContentUnchanged } from '../mobile-session-snapshot-equality'

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
        ? this.getWorkspaceSessionForWorktree(worktreeId)
        : this.store?.getWorkspaceSession?.())
    if (!session) {
      return reconciledWorktreeIds
    }
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
              ...Object.keys(session.openFilesByWorktree ?? {})
            ])
          ].map((id) => [id, session.tabsByWorktree?.[id] ?? []] as const)
    // Skip removed-repo session keys to avoid phantom workspaces; resolve inventory lazily for parseable keys and preserve unknown inventory as unavailable.
    let liveRepoIds: Set<string> | null | undefined
    for (const [entryWorktreeId, persistedTabs] of entries) {
      const ownerRepoId = splitWorktreeIdForFilesystem(entryWorktreeId)?.repoId
      if (ownerRepoId) {
        if (liveRepoIds === undefined) {
          const knownRepos = this.store?.getRepos?.()
          liveRepoIds = knownRepos ? new Set(knownRepos.map((repo) => repo.id)) : null
        }
        if (liveRepoIds && !liveRepoIds.has(ownerRepoId)) {
          continue
        }
      }
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
      // Windowless hosts have no other row publisher; a filtered seed would suppress the full rebuild.
      const runtimeOwnedOnly =
        options.onlyRuntimeOwnedTerminals === true &&
        (existing !== undefined || hasAuthoritativeWindow)
      const terminalTabs = buildHeadlessMobileSessionTerminalTabs(
        entryWorktreeId,
        persistedTabs,
        session,
        this.store?.getSettings?.()?.tabAutoGenerateTitle === true
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
      if (tabs.length === 0) {
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
      const mergedTerminalTabs = mergedTabs.filter(
        (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
      )
      // Editors ride with browsers: both keep their persisted group, unlike terminal parents.
      const mergedBrowserOrder = mergedTabs
        .filter((tab) => tab.type === 'browser' || tab.type === 'markdown' || tab.type === 'file')
        .map((tab) => tab.id)
      // Restore persisted split groups or cold rebuilds coalesce them into one.
      const persistedGroups = session.tabGroups?.[entryWorktreeId]
      const persistedLayout = session.tabGroupLayouts?.[entryWorktreeId]
      const hasPersistedSplit =
        !runtimeOwnedOnly && persistedGroups !== undefined && persistedGroups.length > 1
      const activeTopLevelId = mergedActiveTab
        ? mergedActiveTab.type === 'terminal'
          ? mergedActiveTab.parentTabId
          : mergedActiveTab.id
        : null
      const rebuiltTabGroups: RuntimeMobileSessionTabGroup[] = hasPersistedSplit
        ? appendBrowserTabOrder(
            distributeHeadlessTabsAcrossGroups(
              persistedGroups.map((group) => ({
                id: group.id,
                activeTabId: group.activeTabId,
                tabOrder: [...group.tabOrder],
                ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
              })),
              collectHeadlessParentTabOrder(mergedTerminalTabs),
              activeTopLevelId
            ),
            mergedBrowserOrder,
            undefined,
            // Terminal-only distribution drops browsers; retain their persisted groups separately.
            collectBrowserGroupAssignment(persistedGroups, mergedBrowserOrder)
          )
        : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroups
          ? appendBrowserTabOrder(
              mergeMobileSessionTabGroups(
                entryWorktreeId,
                existing.tabGroups,
                mergedTabs,
                mergedActiveTab?.type === 'terminal' ? mergedActiveTab : null
              ),
              mergedBrowserOrder
            )
          : [
              {
                id: groupId,
                activeTabId: mergedActiveTab?.id
                  ? (activeTab?.parentTabId ?? mergedActiveTab.id)
                  : (tabOrder[0] ?? null),
                tabOrder
              }
            ]
      const nextTabGroups = appendChatTabOrder(rebuiltTabGroups, existing?.tabGroups, mergedTabs)
      // Keep renderer base epochs when merging runtime rows, or preservation misclassifies renderer tabs as runtime-owned and resurrects closed tabs.
      const mergedIntoRendererPublication =
        options.onlyRuntimeOwnedTerminals === true &&
        existing !== undefined &&
        !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
      const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: existing?.worktree ?? entryWorktreeId,
        publicationEpoch: mergedIntoRendererPublication
          ? this.getMergedMobileSessionPublicationEpoch(existing, tabs)
          : `headless-hydrated:${Date.now().toString(36)}`,
        snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
        activeGroupId: hasPersistedSplit
          ? pickRestoredActiveGroupId(
              nextTabGroups,
              [existing?.activeGroupId, session.activeGroupIdByWorktree?.[entryWorktreeId]],
              activeTopLevelId
            )
          : (existing?.activeGroupId ?? groupId),
        activeTabId: mergedActiveTab?.id ?? null,
        activeTabType: mergedActiveTab?.type ?? null,
        tabGroups: nextTabGroups,
        // Carry split layout through runtime hydration on every graph sync to avoid dropping/rebroadcasting it.
        ...(hasPersistedSplit && persistedLayout
          ? { tabGroupLayout: persistedLayout }
          : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroupLayout
            ? { tabGroupLayout: existing.tabGroupLayout }
            : {}),
        tabs: mergedTabs
      }
      // Retain the existing object and version for equal projections so unchanged graph syncs do not fan out.
      if (existing && headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.storeMobileSessionSnapshot(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }
}
