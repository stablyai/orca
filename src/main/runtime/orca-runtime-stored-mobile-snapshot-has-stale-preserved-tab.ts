// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs } from './orca-runtime-merge-preserved-headless-mobile-session-tabs'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { getMobileSessionSnapshotTabIdentityKeys } from './mobile-session-tab-merge'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'

export class OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab extends OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs {
  // Why: the accepted-revision no-op gate must not fossilize preserved runtime
  // tabs. A stored merged snapshot's tabs absent from the accepted renderer
  // publication exist only via preservation; if any such tab no longer
  // passes the preservation predicate (binding removed from the live PTY table
  // and persisted session, or browser page closed), the stored snapshot is stale.
  protected storedMobileSnapshotHasStalePreservedTab(
    existing: RuntimeMobileSessionTabsSnapshot,
    rendererTabIdentityKeys: ReadonlySet<string>
  ): boolean {
    return existing.tabs.some(
      (tab) =>
        !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
          rendererTabIdentityKeys.has(id)
        ) && !this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    )
  }

  protected collectPreservedHeadlessMobileSessionTabs(
    existing: RuntimeMobileSessionTabsSnapshot,
    incoming?: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionSnapshotTab[] {
    const incomingIds = new Set(
      incoming?.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab)) ?? []
    )
    return existing.tabs.filter((tab) => {
      if (getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))) {
        return false
      }
      return this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    })
  }

  protected shouldPreserveHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean {
    if (tab.type === 'agent-session') {
      return true
    }
    if (tab.type === 'browser') {
      const liveClientPage =
        typeof tab.browserPageId === 'string'
          ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
          : undefined
      if (
        liveClientPage?.workspaceId === snapshot.worktree &&
        tab.placement?.kind === 'client' &&
        sameRuntimeBrowserPlacement(liveClientPage.placement, tab.placement)
      ) {
        return true
      }
      // Why: headless offscreen browser tabs exist only server-side, so a renderer-graph merge must keep them, not prune as "not in the graph".
      if (!this.offscreenBrowserBackend) {
        return false
      }
      // Why: in a renderer-based merged snapshot the browser entries can also
      // be renderer-owned, so only pages the offscreen bridge still lists are
      // runtime-owned and preservable; a pure renderer epoch preserves none.
      return (
        this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
        (snapshot.publicationEpoch.includes(':headless-merge:') &&
          typeof tab.browserPageId === 'string' &&
          this.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId))
      )
    }
    if (tab.type !== 'terminal') {
      return false
    }
    if (this.pendingMobileTerminalCreatesByKey.has(`${snapshot.worktree}::${tab.parentTabId}`)) {
      return true
    }
    // Why: a merged renderer snapshot carries BOTH renderer-owned and
    // runtime-owned tabs, so the epoch alone must not preserve every terminal —
    // that resurrects renderer tabs the renderer already closed. Broad
    // preservation applies only to genuinely headless-built snapshots; in a
    // renderer-based one, only tabs with a live-or-persisted serve/SSH binding
    // are runtime-owned and preservable.
    return (
      this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
      this.hasLiveRuntimeSessionOwnedPtyBinding(snapshot.worktree, tab) ||
      this.hasLiveOrPersistedServeOrSshOwnedPtyBinding(snapshot.worktree, tab)
    )
  }

  protected isHeadlessMobileSessionPublication(publicationEpoch: string): boolean {
    return (
      publicationEpoch.startsWith('headless:') ||
      publicationEpoch.startsWith('headless-hydrated:') ||
      publicationEpoch.includes(':headless-merge:')
    )
  }

  // Why: `:headless-merge:` only marks that runtime tabs were merged in — the
  // BASE epoch still says who published the snapshot. A renderer-based merged
  // snapshot must not be classified as headless-built, or its renderer tabs
  // read as runtime-owned.
  protected isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    const base = publicationEpoch.split(':headless-merge:')[0]
    return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
  }

  protected getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    _preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Why: preserved snapshots can merge repeatedly; strip the prior merge suffix first so the publication epoch stays idempotent.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    // The epoch identifies the publisher generation, not the merged content.
    // Content changes are ordered by snapshotVersion, so encoding a merge hash
    // here would make the identity oscillate and permanently fence later rows.
    return normalizedPublicationEpoch
  }

  /** Serves a hydrating host renderer; the publisher counts this as a delivery, not a read. */
  listClientHostedBrowserRows(): ClientHostedBrowserRowsEvent[] {
    return this.clientHostedBrowserRows.deliverHydrationSnapshot()
  }

  protected notifyMobileSessionTabsRemoved(worktreeId: string): void {
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      worktree: worktreeId,
      publicationEpoch: `removed:${Date.now().toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.clientSessionTabSelections.project(removed, subscription.clientNavigationId),
        changeSequence
      )
    }
    this.clientSessionTabSelections.forgetWorktree(worktreeId)
  }

  notifyMobileSessionTabsChanged(worktreeId?: string): void {
    if (!worktreeId) {
      this.clientHostedBrowserRows.publishAll()
      for (const id of new Set([
        ...this.persistedClientHostedBrowserWorktreeIds,
        ...getRuntimeBrowserPageRegistry(this)
          .listPages()
          .map((page) => page.workspaceId)
      ])) {
        this.persistClientHostedBrowserPagesForWorktree(id)
      }
      this.notifyMobileSessionTabSnapshots()
      return
    }
    // Why: every client-page mutation — create, navigate, metadata, host quit, recovery — reaches
    // this announcement, so the host's own rows derive from it rather than from a second seam.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const hasClientBrowserPages =
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length > 0
    if (this.offscreenBrowserBackend || hasClientBrowserPages) {
      const reconciled = this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId,
        hasClientBrowserPages
          ? { allowAttachedWindow: true, onlyRuntimeOwnedTerminals: true }
          : undefined
      )
      // Why: hydrate already reconciles an existing snapshot in place; only reconcile here when it didn't (fresh build or early-returned hydrate).
      if (!reconciled.has(worktreeId)) {
        const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
  }
}
