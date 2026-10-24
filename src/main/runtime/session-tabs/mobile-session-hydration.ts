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
    // Why: only the persisted session feeds a headless-built snapshot, so an empty one is never an
    // answer — as a base it made the next pass seed browser rows alone and hide every terminal.
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
    // Why: report which worktrees were reconciled in place so callers don't
    // reconcile them a second time (see notifyMobileSessionTabsChanged).
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
    // Why: with no runtime-owned candidate in the session and no offscreen
    // browser backend, this hydrate provably builds zero tabs for
    // every worktree — skip the per-worktree rebuild entirely (hot on every
    // graph sync). Scoped to onlyRuntimeOwnedTerminals so full hydrates are
    // untouched.
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
    // Why: workspaceSession keys are `${repoId}::${path}` and are not pruned when
    // a repo disappears from this client's view (e.g. removed on another client,
    // or a stale browser-persisted session). Hydrating such a key would surface a
    // phantom "unknown"/duplicate workspace with no live repo behind it. Only
    // hydrate sessions whose repo still exists; leave unparseable keys alone.
    // Resolved lazily so unparseable keys (floating terminals) never pay for a
    // repo inventory on the hot poll path, and `null` when the store cannot
    // report repos — an unavailable list must not read as "every repo is gone".
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
        // Why: terminals are stable/persisted so we normally skip a rebuild, but
        // offscreen browser tabs are live and may have been created/closed since.
        // Reconcile just the browser tabs against the live bridge instead of
        // leaving a stale snapshot that omits a freshly-opened browser tab.
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, stored)
        reconciledWorktreeIds.add(entryWorktreeId)
        // Why: closing the last browser row empties a browser-only snapshot; rebuild it now
        // rather than serve that empty answer once.
        if (this.readRebuildableMobileSessionSnapshot(entryWorktreeId)) {
          continue
        }
      }
      const existing = this.readRebuildableMobileSessionSnapshot(entryWorktreeId)
      // Why: windowless, nothing publishes the other tabs, and a filtered seed would make the full pass skip this worktree.
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
      // Why: offscreen browser panes are live-only (no persisted session entry),
      // so include them on every hydrate regardless of the onlyRuntimeOwnedTerminals
      // filter, which is about terminal PTY ownership and never applies to browsers.
      const browserTabs = this.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      // Why not in the runtime-owned pass: that merges into a renderer's publication, which owns its editors.
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
      // Why: a persisted multi-group split must be restored on cold rebuild, or
      // the headless serve coalesces the user's group layout back into one group
      // (the persisted tabGroups/tabGroupLayouts would otherwise be write-only).
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
            // Why: distribute drops browser ids (terminal-only), so carry each
            // browser's persisted group forward instead of coalescing left.
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
      // Why: merging runtime tabs INTO a renderer publication must not reclass
      // the snapshot as headless-built — the preservation predicate would then
      // treat the renderer's own tabs as runtime-owned and resurrect tabs the
      // renderer later closes. Keep the renderer base epoch with a merge suffix
      // (idempotent) so ownership stays derivable from the epoch.
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
        // Why: the runtime-owned rebuild runs on every graph sync — carry the
        // existing split layout forward or each sync drops it and fans out.
        ...(hasPersistedSplit && persistedLayout
          ? { tabGroupLayout: persistedLayout }
          : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroupLayout
            ? { tabGroupLayout: existing.tabGroupLayout }
            : {}),
        tabs: mergedTabs
      }
      // Why: the runtime-owned hydrate runs on EVERY graph sync; when the rebuilt
      // projection matches the existing snapshot, keep the existing object and
      // (epoch, version) untouched so identity-based change detection stays a
      // pure no-op and unchanged runtime/browser worktrees never fan out.
      if (existing && headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.storeMobileSessionSnapshot(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }
}
