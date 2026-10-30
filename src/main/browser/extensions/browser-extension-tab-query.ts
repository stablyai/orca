/// <reference types="chrome" />
import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'

/** Query keys Orca answers; the preload strips them before Electron's native query runs. */
export type OrcaTabQuery = {
  active?: boolean
  highlighted?: boolean
  currentWindow?: boolean
  lastFocusedWindow?: boolean
  windowId?: number
  windowType?: string
  status?: string
  index?: number
  pinned?: boolean
  discarded?: boolean
  frozen?: boolean
  groupId?: number
}

export type OrcaTabQueryContext = {
  callerWindowId: number | null
  lastFocusedWindowId: number | null
  windowTypeById: ReadonlyMap<number, string>
}

const WINDOW_ID_CURRENT = -2

function windowMatches(
  flag: boolean | undefined,
  windowId: number,
  wanted: number | null
): boolean {
  return flag === undefined || (wanted !== null && windowId === wanted) === flag
}

/** chrome.tabs.query semantics for the fields Electron cannot know (window, activation, status). */
export function matchesOrcaTabQuery(
  tab: chrome.tabs.Tab,
  query: OrcaTabQuery,
  context: OrcaTabQueryContext
): boolean {
  if (query.active !== undefined && tab.active !== query.active) {
    return false
  }
  if (query.highlighted !== undefined && tab.highlighted !== query.highlighted) {
    return false
  }
  if (!windowMatches(query.currentWindow, tab.windowId, context.callerWindowId)) {
    return false
  }
  if (!windowMatches(query.lastFocusedWindow, tab.windowId, context.lastFocusedWindowId)) {
    return false
  }
  if (query.windowId !== undefined) {
    const wanted = query.windowId === WINDOW_ID_CURRENT ? context.callerWindowId : query.windowId
    if (tab.windowId !== wanted) {
      return false
    }
  }
  if (
    query.windowType !== undefined &&
    context.windowTypeById.get(tab.windowId) !== query.windowType
  ) {
    return false
  }
  if (query.status !== undefined && tab.status !== query.status) {
    return false
  }
  if (query.index !== undefined && tab.index !== query.index) {
    return false
  }
  if (query.discarded !== undefined && tab.discarded !== query.discarded) {
    return false
  }
  // Orca has no pinned, frozen or grouped tabs.
  if (query.pinned === true || query.frozen === true) {
    return false
  }
  return query.groupId === undefined || query.groupId === -1
}

/** Chrome's title pattern: `*` matches any run of characters, everything else literally. */
function matchesTitlePattern(pattern: string, title: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's').test(title)
}

/**
 * The query keys Electron's native query answers for loaded tabs, for a discarded tab Electron
 * never sees: its url/title (only when visible to the caller), and its silent, unmuted state.
 */
export function matchesDiscardedTabNativeQuery(
  tab: chrome.tabs.Tab,
  query: Record<string, unknown>
): boolean {
  const urlPatterns =
    typeof query.url === 'string' ? [query.url] : Array.isArray(query.url) ? query.url : null
  if (
    urlPatterns &&
    !urlPatterns.some(
      (pattern) =>
        typeof pattern === 'string' &&
        tab.url !== undefined &&
        matchesExtensionMatchPattern(pattern, tab.url)
    )
  ) {
    return false
  }
  if (
    typeof query.title === 'string' &&
    (tab.title === undefined || !matchesTitlePattern(query.title, tab.title))
  ) {
    return false
  }
  return query.audible !== true && query.muted !== true && query.autoDiscardable !== false
}
