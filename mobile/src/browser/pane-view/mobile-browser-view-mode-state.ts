import { useSyncExternalStore } from 'react'
import type { MobileBrowserViewMode } from '../screencast/browser-screencast-request-parameters'

const BROWSER_VIEW_MODE_STATE_LIMIT = 40
const browserViewModeByPageKey = new Map<string, MobileBrowserViewMode>()
// Pages this phone opened; kept apart so they never evict a page's explicit choice.
const phoneOpenedPageKeys = new Set<string>()
const phoneOpenedPageListeners = new Set<() => void>()

export function getInitialMobileBrowserViewMode(
  worktreeId: string,
  browserPageId: string | null,
  url = 'about:blank'
): MobileBrowserViewMode {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  if (!pageKey) {
    return defaultMobileBrowserViewMode(url)
  }
  return (
    browserViewModeByPageKey.get(pageKey) ??
    (phoneOpenedPageKeys.has(pageKey) ? 'mobile' : defaultMobileBrowserViewMode(url))
  )
}

/** A page the phone opened is read on the phone, so it starts at phone width. */
export function markPhoneOpenedBrowserPage(worktreeId: string, browserPageId: string): void {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  if (!pageKey || phoneOpenedPageKeys.has(pageKey)) {
    return
  }
  phoneOpenedPageKeys.add(pageKey)
  trimOldestKeys(phoneOpenedPageKeys)
  for (const listener of phoneOpenedPageListeners) {
    listener()
  }
}

/** True once the phone has opened this page, including after the pane mounted (the host replies after first load). */
export function usePhoneOpenedBrowserPage(
  worktreeId: string,
  browserPageId: string | null
): boolean {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  return useSyncExternalStore(subscribePhoneOpenedPages, () =>
    pageKey ? phoneOpenedPageKeys.has(pageKey) : false
  )
}

function subscribePhoneOpenedPages(listener: () => void): () => void {
  phoneOpenedPageListeners.add(listener)
  return () => phoneOpenedPageListeners.delete(listener)
}

function defaultMobileBrowserViewMode(url: string): MobileBrowserViewMode {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && /\.html?$/i.test(parsed.pathname) ? 'mobile' : 'web'
  } catch {
    return 'web'
  }
}

export function saveMobileBrowserViewMode(
  worktreeId: string,
  browserPageId: string | null,
  viewMode: MobileBrowserViewMode
): void {
  const pageKey = makeBrowserViewModePageKey(worktreeId, browserPageId)
  if (!pageKey) {
    return
  }
  browserViewModeByPageKey.delete(pageKey)
  browserViewModeByPageKey.set(pageKey, viewMode)
  trimOldestKeys(browserViewModeByPageKey)
}

function trimOldestKeys(keys: Map<string, unknown> | Set<string>): void {
  while (keys.size > BROWSER_VIEW_MODE_STATE_LIMIT) {
    const oldestKey = keys.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    keys.delete(oldestKey)
  }
}

export function clearMobileBrowserViewModeState(): void {
  browserViewModeByPageKey.clear()
  phoneOpenedPageKeys.clear()
}

function makeBrowserViewModePageKey(
  worktreeId: string,
  browserPageId: string | null
): string | null {
  return browserPageId ? `${worktreeId}:${browserPageId}` : null
}
