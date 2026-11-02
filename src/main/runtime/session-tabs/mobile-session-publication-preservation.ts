import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import { OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs } from './mobile-session-preservation'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { getMobileSessionSnapshotTabIdentityKeys } from '../mobile-session-tab-merge'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { isHeadlessBuiltPublication } from '../mobile-session-snapshot-equality'
import { sameRuntimeBrowserPlacement } from '../../../shared/runtime-browser-placement'
import type { ClientHostedBrowserRowsEvent } from '../../../shared/client-hosted-browser-rows'

export abstract class OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab extends OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs {
  protected abstract getListedBrowserTabsByPageId(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['getListedBrowserTabsByPageId']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['getListedBrowserTabsByPageId']>
  protected abstract notifyMobileSessionTabsChangedNow(
    ...args: Parameters<
      ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabsChangedNow']
    >
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabsChangedNow']>

  // Accepted renderer resends must still prune preserved runtime tabs whose live/durable binding or browser page disappeared.
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
    // Even headless-built bases must drop renderer-durably-closed tabs on first publication after restart (STA-4897).
    const retiredTabIds =
      incoming && this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
        ? new Set(this.listRendererRetiredTerminalTabs(incoming, existing).map(({ tab }) => tab.id))
        : null
    return existing.tabs.filter((tab) => {
      if (getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))) {
        return false
      }
      if (
        tab.type === 'terminal' &&
        retiredTabIds?.has(tab.id) &&
        !this.hasLiveOrPersistedServeOrSshOwnedPtyBinding(existing.worktree, tab)
      ) {
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
      // Offscreen browsers exist only server-side; preserve them across renderer graph merges.
      if (!this.offscreenBrowserBackend) {
        return false
      }
      // Merges keep the renderer epoch, so runtime-owned pages are those outside the accepted identity set.
      return (
        this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
        (this.isHeadlessOwnedMobileBrowserTab(snapshot, tab) &&
          typeof tab.browserPageId === 'string' &&
          this.getListedBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId))
      )
    }
    if (tab.type !== 'terminal') {
      return false
    }
    if (this.pendingMobileTerminalCreatesByKey.has(`${snapshot.worktree}::${tab.parentTabId}`)) {
      return true
    }
    // Broad terminal preservation applies only to headless-built snapshots; renderer-based merges require live/durable serve/SSH evidence or closed renderer tabs resurrect.
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

  // Headless-merge suffixes do not change the base publisher; renderer-based snapshots must retain renderer ownership.
  protected isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    return isHeadlessBuiltPublication(publicationEpoch)
  }

  protected getAcceptedRendererIdentityKeysForMobileSessionSnapshot(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): ReadonlySet<string> | null {
    const baseEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
    return accepted?.publicationEpoch === baseEpoch ? accepted.rendererTabIdentityKeys : null
  }

  protected isHeadlessOwnedMobileBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    if (this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch)) {
      return true
    }
    const rendererTabIdentityKeys =
      this.getAcceptedRendererIdentityKeysForMobileSessionSnapshot(snapshot)
    if (rendererTabIdentityKeys) {
      return !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
        rendererTabIdentityKeys.has(id)
      )
    }
    return false
  }

  protected isRendererOwnedMobileBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    // A closed window's webviews are gone, so its rows need live pages like any other.
    if (tab.placement?.kind === 'client' || !this.getAvailableAuthoritativeWindow()) {
      return false
    }
    return !this.isHeadlessOwnedMobileBrowserTab(snapshot, tab)
  }

  protected getRendererOwnedBrowserPageIds(worktreeId: string): Set<string> {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    return new Set(
      snapshot?.tabs.flatMap((tab) =>
        tab.type === 'browser' &&
        tab.browserPageId &&
        this.isRendererOwnedMobileBrowserTab(snapshot, tab)
          ? [tab.browserPageId]
          : []
      )
    )
  }

  // Headless publications re-stamp on page retirement; renderer publications keep their publisher epoch.
  protected getMobileSessionPublicationEpochAfterHeadlessBrowserClose(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): string {
    return this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch)
      ? `headless:${Date.now().toString(36)}`
      : this.getMergedMobileSessionPublicationEpoch(snapshot, [])
  }

  protected getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    _preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Strip prior merge suffixes so repeated merges keep an idempotent epoch.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    // Epoch identifies publisher generation; content changes use snapshotVersion. Content hashes would oscillate identity and fence later rows.
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
    // Derive host rows from the page registry's single announcement for every mutation, including quit/recovery.
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
      // Reconcile only snapshots hydrate did not already update in place.
      if (!reconciled.has(worktreeId)) {
        const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Publish structural changes immediately and cancel superseded coalesced notices.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
  }
}
