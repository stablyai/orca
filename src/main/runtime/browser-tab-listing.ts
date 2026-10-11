import type { BrowserTabInfo } from '../../shared/runtime-browser-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

/** A browser tab as the tab bar shows it, whether or not its page has loaded. */
export type BrowserTabBarEntry = {
  browserPageId: string
  worktreeId: string
  title: string
  url: string
  loadError: BrowserTabInfo['loadError']
  certificateFailure: BrowserTabInfo['certificateFailure']
}

/**
 * The browser tabs of one worktree, or of every worktree, in tab-bar order. Read from the session
 * snapshot the renderer publishes on every tab change, which keeps restored tabs that never loaded.
 */
export function readBrowserTabBar(
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  worktreeId: string | undefined
): BrowserTabBarEntry[] {
  const selected = worktreeId
    ? [snapshots.get(worktreeId)].filter((snapshot) => snapshot !== undefined)
    : [...snapshots.values()]
  return selected.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'browser' && tab.browserPageId && !tab.placement
        ? [
            {
              browserPageId: tab.browserPageId,
              worktreeId: snapshot.worktree,
              title: tab.title,
              url: tab.url,
              loadError: tab.loadError ?? null,
              certificateFailure: tab.certificateFailure ?? null
            }
          ]
        : []
    )
  )
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
            // Why null: the tab bar does not record a page's profile until the page loads.
            profileId: null,
            profileLabel: null,
            loaded: false
          }
    )
  }
  const unlisted = input.liveTabs
    .filter((tab) => !listed.has(tab.browserPageId))
    .map((tab) => ({ ...tab, loaded: true }))
  const clients = input.clientTabs.map((tab) => ({ ...tab, loaded: true }))
  const tabs = [...fromBar, ...unlisted, ...clients]
  const fallbackActive = tabs.findIndex((tab) => tab.loaded)
  if (fallbackActive !== -1 && !tabs.some((tab) => tab.active)) {
    tabs[fallbackActive] = { ...tabs[fallbackActive]!, active: true }
  }
  return tabs.map((tab, index) => ({ ...tab, index }))
}
