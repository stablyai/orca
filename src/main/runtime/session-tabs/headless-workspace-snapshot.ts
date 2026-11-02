import type { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs as BuildHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/build-headless-mobile-session-browser-tabs'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import type { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs as ReconcileHeadlessMobileSessionBrowserTabsMethods } from '../session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'
import { RuntimeSessionTabsInventoryPublication } from './session-tabs-inventory-publication'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
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

export abstract class OrcaRuntimeWithBuildHeadlessWorkspaceSnapshot extends RuntimeSessionTabsInventoryPublication {
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

  /** This host's frame for one workspace from its saved layout: terminal, editor and browser rows
   *  and groups, keeping `existing`'s chat rows. Null when it has no rows, unless `keepEmpty`. */
  protected buildHeadlessWorkspaceSnapshot(
    entryWorktreeId: string,
    persistedTabs: WorkspaceSessionState['tabsByWorktree'][string],
    session: WorkspaceSessionState,
    existing: RuntimeMobileSessionTabsSnapshot | undefined,
    options: { onlyRuntimeOwnedTerminals: boolean; runtimeOwnedOnly: boolean; keepEmpty?: boolean }
  ): RuntimeMobileSessionTabsSnapshot | null {
    const runtimeOwnedOnly = options.runtimeOwnedOnly
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
    const tabs: RuntimeMobileSessionSnapshotTab[] = [...terminalTabs, ...editorTabs, ...browserTabs]
    if (tabs.length === 0 && !options.keepEmpty) {
      return null
    }
    const activeTab = pickHeadlessActiveTerminalTab(terminalTabs)
    const tabOrder = [
      ...collectHeadlessParentTabOrder(terminalTabs),
      ...editorTabs.map((tab) => tab.id),
      ...browserTabs.map((tab) => tab.id)
    ]
    const groupId = getHeadlessMobileSessionGroupId(entryWorktreeId)
    const mergedTabs =
      options.onlyRuntimeOwnedTerminals && existing
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
      : options.onlyRuntimeOwnedTerminals && existing?.tabGroups
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
      options.onlyRuntimeOwnedTerminals &&
      existing !== undefined &&
      !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
    return {
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
        : options.onlyRuntimeOwnedTerminals && existing?.tabGroupLayout
          ? { tabGroupLayout: existing.tabGroupLayout }
          : {}),
      tabs: mergedTabs
    }
  }
}
