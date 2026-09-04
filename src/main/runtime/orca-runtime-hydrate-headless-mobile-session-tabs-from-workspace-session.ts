// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWaitForSessionTabsInventoryPublication } from './orca-runtime-wait-for-session-tabs-inventory-publication'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import {
  collectHeadlessParentTabOrder,
  distributeHeadlessTabsAcrossGroups,
  getHeadlessMobileSessionGroupId,
  pickHeadlessActiveTerminalTab
} from './mobile-session-layout-projection'
import {
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from './mobile-session-tab-merge'
import {
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from './mobile-session-browser-group-projection'
import { headlessMobileSnapshotContentUnchanged } from './mobile-session-snapshot-equality'

export class OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession extends OrcaRuntimeWithWaitForSessionTabsInventoryPublication {
  protected hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
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
    if (this.getAvailableAuthoritativeWindow() && options.allowAttachedWindow !== true) {
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
    const entries =
      worktreeId !== undefined
        ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
        : Object.entries(session.tabsByWorktree ?? {})
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
      const existing = this.mobileSessionTabsByWorktree.get(entryWorktreeId)
      if (
        existing &&
        existing.tabs.length > 0 &&
        options.force !== true &&
        options.onlyRuntimeOwnedTerminals !== true
      ) {
        // Why: terminals are stable/persisted so we normally skip a rebuild, but
        // offscreen browser tabs are live and may have been created/closed since.
        // Reconcile just the browser tabs against the live bridge instead of
        // leaving a stale snapshot that omits a freshly-opened browser tab.
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, existing)
        reconciledWorktreeIds.add(entryWorktreeId)
        continue
      }
      const terminalTabs = buildHeadlessMobileSessionTerminalTabs(
        entryWorktreeId,
        persistedTabs,
        session
      ).filter(
        (tab) =>
          options.onlyRuntimeOwnedTerminals !== true ||
          this.hasServeOrSshOwnedBinding(tab) ||
          this.hasRecentExpiredSshLeasePane(entryWorktreeId, tab)
      )
      // Why: offscreen browser panes are live-only (no persisted session entry),
      // so include them on every hydrate regardless of the onlyRuntimeOwnedTerminals
      // filter, which is about terminal PTY ownership and never applies to browsers.
      const browserTabs = this.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      const tabs: RuntimeMobileSessionSnapshotTab[] = [...terminalTabs, ...browserTabs]
      if (tabs.length === 0) {
        continue
      }
      const activeTab = pickHeadlessActiveTerminalTab(terminalTabs)
      const tabOrder = [
        ...collectHeadlessParentTabOrder(terminalTabs),
        ...browserTabs.map((tab) => tab.id)
      ]
      const groupId = getHeadlessMobileSessionGroupId(entryWorktreeId)
      const mergedTabs =
        options.onlyRuntimeOwnedTerminals === true && existing
          ? mergeMobileSessionSnapshotTabs(existing.tabs, tabs)
          : tabs
      const mergedActiveTab =
        existing?.tabs.find((tab) => tab.id === existing.activeTabId) ??
        activeTab ??
        mergedTabs[0] ??
        null
      const mergedTerminalTabs = mergedTabs.filter(
        (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
      )
      const mergedBrowserOrder = mergedTabs
        .filter((tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser')
        .map((tab) => tab.id)
      // Why: a persisted multi-group split must be restored on cold rebuild, or
      // the headless serve coalesces the user's group layout back into one group
      // (the persisted tabGroups/tabGroupLayouts would otherwise be write-only).
      const persistedGroups = session.tabGroups?.[entryWorktreeId]
      const persistedLayout = session.tabGroupLayouts?.[entryWorktreeId]
      const hasPersistedSplit =
        options.onlyRuntimeOwnedTerminals !== true &&
        persistedGroups !== undefined &&
        persistedGroups.length > 1
      const activeTopLevelId = mergedActiveTab
        ? mergedActiveTab.type === 'terminal'
          ? mergedActiveTab.parentTabId
          : mergedActiveTab.id
        : null
      const nextTabGroups: RuntimeMobileSessionTabGroup[] = hasPersistedSplit
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
                mergedTerminalTabs,
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
        activeGroupId: existing?.activeGroupId ?? groupId,
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
