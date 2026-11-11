import { browserMemoryGeneration } from '../../../browser/guest-lifecycle/browser-page-memory'
import type { BrowserTabInfo } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'

/** A browser tab as the tab bar shows it, whether or not its page has loaded. */
export type BrowserTabBarEntry = {
  browserPageId: string
  worktreeId: string
  title: string
  url: string
  loadError: BrowserTabInfo['loadError']
  certificateFailure: BrowserTabInfo['certificateFailure']
  profileId?: string | null
  profileLabel?: string | null
}

/**
 * The browser tabs of one worktree, or of every worktree, in tab-bar order. Read from the session
 * snapshot the renderer publishes on every tab change, which keeps restored tabs that never loaded.
 */
export function readBrowserTabBar(
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  worktreeId: string | undefined,
  ownsWorkspace: (worktreeId: string) => boolean
): BrowserTabBarEntry[] {
  const selected = worktreeId
    ? [snapshots.get(worktreeId)].filter((snapshot) => snapshot !== undefined)
    : [...snapshots.values()]
  const result: BrowserTabBarEntry[] = []
  const remaining: BrowserTabBarEntry[] = []
  for (const snapshot of selected) {
    // Mirrored workspaces belong to their server, which alone can recover their pages.
    if (!ownsWorkspace(snapshot.worktree)) {
      continue
    }
    const inventory = snapshot.browserPageInventory
    const savedById = inventory && new Map(inventory.map((page) => [page.browserPageId, page]))
    const listed = new Set<string>()
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'browser' || !tab.browserPageId || tab.placement) {
        continue
      }
      const saved = savedById?.get(tab.browserPageId)
      if (inventory && !saved) {
        continue
      }
      listed.add(tab.browserPageId)
      result.push({
        browserPageId: tab.browserPageId,
        worktreeId: snapshot.worktree,
        title: saved?.title ?? tab.title,
        url: saved?.url ?? tab.url,
        loadError: saved ? saved.loadError : (tab.loadError ?? null),
        certificateFailure: saved ? saved.certificateFailure : (tab.certificateFailure ?? null),
        profileId: saved?.profileId ?? null
      })
    }
    for (const page of inventory ?? []) {
      if (!listed.has(page.browserPageId)) {
        remaining.push({
          browserPageId: page.browserPageId,
          worktreeId: snapshot.worktree,
          title: page.title,
          url: page.url,
          loadError: page.loadError,
          certificateFailure: page.certificateFailure,
          profileId: page.profileId
        })
      }
    }
  }
  return [...result, ...remaining]
}

/**
 * Lists the tab bar's tabs first, live pages where loaded and the bar's record otherwise, then live
 * pages the bar does not show yet (just created, or a tab's other pages), then client-hosted pages.
 */
export function mergeBrowserTabListing(input: {
  tabBar: readonly BrowserTabBarEntry[]
  liveTabs: readonly BrowserTabInfo[]
  clientTabs: readonly BrowserTabInfo[]
}): BrowserTabInfo[] {
  const liveById = new Map(input.liveTabs.map((tab) => [tab.browserPageId, tab]))
  const clientIds = new Set(input.clientTabs.map((tab) => tab.browserPageId))
  const listed = new Set<string>()
  const fromBar: BrowserTabInfo[] = []
  for (const entry of input.tabBar) {
    if (listed.has(entry.browserPageId) || clientIds.has(entry.browserPageId)) {
      continue
    }
    listed.add(entry.browserPageId)
    const live = liveById.get(entry.browserPageId)
    fromBar.push(
      live
        ? { ...live, loaded: true }
        : {
            browserPageId: entry.browserPageId,
            index: 0,
            url: entry.url,
            title: entry.title,
            // Why: commands without --page act on the live active page, so a tab with none is never it.
            active: false,
            loadError: entry.loadError,
            certificateFailure: entry.certificateFailure,
            worktreeId: entry.worktreeId,
            profileId: entry.profileId ?? null,
            profileLabel: entry.profileLabel ?? null,
            loaded: false
          }
    )
  }
  // Why clientIds: the client row stays the only entry for an id both registries hold.
  const serverTabs = input.liveTabs.filter((tab) => !clientIds.has(tab.browserPageId))
  const unlisted = serverTabs
    .filter((tab) => !listed.has(tab.browserPageId))
    .map((tab) => ({ ...tab, loaded: true }))
  const clients = input.clientTabs.map((tab) => ({ ...tab, loaded: true }))
  const tabs = [...fromBar, ...unlisted, ...clients]
  // Why live order: with nothing active, a pageless command acts on the first live page.
  const fallbackId = (serverTabs[0] ?? input.clientTabs[0] ?? tabs[0])?.browserPageId
  const noneActive = !tabs.some((tab) => tab.active)
  return tabs.map((tab, index) => ({
    ...tab,
    index,
    generation: browserMemoryGeneration(tab.browserPageId),
    active: tab.active || (noneActive && tab.browserPageId === fallbackId)
  }))
}
