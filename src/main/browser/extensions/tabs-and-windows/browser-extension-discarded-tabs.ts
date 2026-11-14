import { borrowWorkspaceSession } from '../../../persistence/loading-store/workspace-sessions/session-host-partitions'
import { webContents } from 'electron'
import type { Store } from '../../../persistence/loading-store/store'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
// oxlint-disable-next-line import/no-cycle -- browser subsystem singleton hub (browserManager); breaking it needs DI and test-mock updates, left for a human
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionProfileForPartition,
  getBrowserExtensionSessionForProfile
} from '../profile-sessions/browser-extension-session-loader'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'
import {
  forgetBrowserPageGuestsGone,
  noteBrowserPageGuestGone,
  unloadedPageIds
} from './browser-extension-unloaded-pages'

/**
 * Orca mounts a browser page's <webview> only when the page is first shown, so a restored page
 * nobody visited has no guest webContents and no tab id. Chrome lists such a page as a discarded
 * tab. Orca reads them from the saved workspace session (the renderer's browser tabs, in every
 * host partition) and names each with a synthetic tab id until its guest loads (tabs.onReplaced).
 */

export type SavedBrowserTabsSource = Pick<
  Store,
  'getWorkspaceSessionHostIds' | 'getWorkspaceSession' | 'onWorkspaceSessionWritten'
>

export type DiscardedBrowserTab = {
  tabId: number
  browserPageId: string
  url: string
  title: string
  session: Electron.Session
}

/** Far past webContents ids (they count up from 1), still a 32-bit int like Chrome's tab ids. */
export const FIRST_DISCARDED_BROWSER_TAB_ID = 1_000_000_000

let source: SavedBrowserTabsSource | null = null
let stopWatchingWrites: (() => void) | null = null
let nextTabId = FIRST_DISCARDED_BROWSER_TAB_ID
const assignedByPageId = new Map<string, { tabId: number; session: Electron.Session }>()

/** The extension session a tab's guest would load in, as the renderer picks its partition. */
function extensionSessionFor(tab: BrowserWorkspace): Electron.Session | null {
  const profile = tab.sessionPartition
    ? getBrowserExtensionProfileForPartition(tab.sessionPartition)
    : (getBrowserExtensionProfile(tab.sessionProfileId ?? 'default') ??
      getBrowserExtensionProfile('default'))
  return profile ? getBrowserExtensionSessionForProfile(profile.id) : null
}

/**
 * Each saved web page with the session its guest would load in, in host order (a page id saved
 * under two hosts comes first from the first). Stops once `visit` returns true.
 */
function visitSavedPages(
  from: SavedBrowserTabsSource,
  visit: (page: BrowserPage, session: Electron.Session) => boolean | void
): void {
  for (const hostId of from.getWorkspaceSessionHostIds()) {
    const state = borrowWorkspaceSession(from, hostId)
    for (const tabs of Object.values(state.browserTabsByWorktree ?? {})) {
      for (const tab of tabs) {
        const session = extensionSessionFor(tab)
        if (!session) {
          continue
        }
        for (const page of state.browserPagesByWorkspace?.[tab.id] ?? []) {
          // A document page is no web page; a runtime-hosted page streams, never a local guest.
          if (
            page.docLocation ||
            (page.remoteBrowserPageId && !page.remoteBrowserPageClientHosted)
          ) {
            continue
          }
          if (visit(page, session)) {
            return
          }
        }
      }
    }
  }
}

function withTabId(page: BrowserPage, session: Electron.Session): DiscardedBrowserTab {
  let assigned = assignedByPageId.get(page.id)
  if (!assigned) {
    assigned = { tabId: nextTabId++, session }
    assignedByPageId.set(page.id, assigned)
  }
  return {
    browserPageId: page.id,
    url: page.url,
    title: page.title,
    session,
    tabId: assigned.tabId
  }
}

function savedPageIdsIn(hostIds: readonly string[]): Set<string> {
  return new Set(
    hostIds.flatMap((hostId) =>
      Object.values(borrowWorkspaceSession(source, hostId)?.browserPagesByWorkspace ?? {}).flatMap(
        (pages) => pages.map((page) => page.id)
      )
    )
  )
}

function hasLiveGuest(browserPageId: string): boolean {
  const id = browserManager.getGuestWebContentsId(browserPageId)
  const contents = id === null ? undefined : webContents.fromId(id)
  return Boolean(contents && !contents.isDestroyed())
}

/** tabs.onRemoved for a synthetic tab, which has no guest whose destruction would announce it. */
export function emitDiscardedBrowserTabRemoved(tab: {
  tabId: number
  session: Electron.Session
}): void {
  const windowId = getBrowserExtensionMainWindow()?.id ?? -1
  emitBrowserExtensionEvent({ session: tab.session }, 'tabs', 'onRemoved', [
    tab.tabId,
    { windowId, isWindowClosing: false }
  ])
}

/** Main's copy of the renderer's saved browser tabs; read on every listing, so never stale for long. */
export function setSavedBrowserTabsSource(next: SavedBrowserTabsSource | null): void {
  stopWatchingWrites?.()
  source = next
  stopWatchingWrites =
    next?.onWorkspaceSessionWritten((hostId) => {
      if (unloadedPageIds.size === 0 && assignedByPageId.size === 0) {
        return
      }
      const allHostIds = next.getWorkspaceSessionHostIds()
      const anywhere = savedPageIdsIn(allHostIds)
      if (unloadedPageIds.size > 0) {
        // Why reuse: a write to every host, or to the only one, saves exactly `anywhere`.
        const written =
          !hostId || (allHostIds.length === 1 && allHostIds[0] === hostId)
            ? anywhere
            : savedPageIdsIn([hostId])
        for (const pageId of unloadedPageIds) {
          if (written.has(pageId) || !anywhere.has(pageId)) {
            unloadedPageIds.delete(pageId)
          }
        }
      }
      // A listed page no save keeps was closed before its guest ever loaded.
      for (const [pageId, assigned] of assignedByPageId) {
        if (!anywhere.has(pageId)) {
          assignedByPageId.delete(pageId)
          emitDiscardedBrowserTabRemoved(assigned)
        }
      }
    }) ?? null
}

/** Saved pages without a live guest, in saved order, each with its synthetic tab id. */
export function listDiscardedBrowserTabs(): DiscardedBrowserTab[] {
  if (!source) {
    return []
  }
  const seen = new Set<string>()
  const tabs: DiscardedBrowserTab[] = []
  visitSavedPages(source, (page, session) => {
    if (seen.has(page.id) || unloadedPageIds.has(page.id)) {
      return
    }
    seen.add(page.id)
    if (!hasLiveGuest(page.id)) {
      tabs.push(withTabId(page, session))
    }
  })
  return tabs
}

/** Looks up one page without listing (and numbering) every other discarded tab. */
export function findDiscardedBrowserTabForPage(browserPageId: string): DiscardedBrowserTab | null {
  if (!source || unloadedPageIds.has(browserPageId) || hasLiveGuest(browserPageId)) {
    return null
  }
  let found: DiscardedBrowserTab | null = null
  visitSavedPages(source, (page, session) => {
    if (page.id !== browserPageId) {
      return false
    }
    found = withTabId(page, session)
    return true
  })
  return found
}

/** A page's guest registered: the synthetic id it was listed under (if any) retires with it. */
export function takeDiscardedBrowserTabId(
  browserPageId: string
): { tabId: number; session: Electron.Session } | null {
  const assigned = assignedByPageId.get(browserPageId) ?? null
  assignedByPageId.delete(browserPageId)
  return assigned
}

export { forgetBrowserPageGuestsGone, noteBrowserPageGuestGone }
