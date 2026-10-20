import { webContents } from 'electron'
import type { Store } from '../../persistence'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { browserManager } from '../browser-manager'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionProfileForPartition,
  getBrowserExtensionSessionForProfile
} from './browser-extension-session-loader'

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
/**
 * Pages whose guest went away. A closed page stays in the saved session until the renderer's next
 * write, so it is listed again only once a write still saves it (an evicted guest's page).
 */
const unloadedPageIds = new Set<string>()

/** The extension session a tab's guest would load in, as the renderer picks its partition. */
function extensionSessionFor(tab: BrowserWorkspace): Electron.Session | null {
  const profile = tab.sessionPartition
    ? getBrowserExtensionProfileForPartition(tab.sessionPartition)
    : (getBrowserExtensionProfile(tab.sessionProfileId ?? 'default') ??
      getBrowserExtensionProfile('default'))
  return profile ? getBrowserExtensionSessionForProfile(profile.id) : null
}

function savedPagesIn(state: WorkspaceSessionState): Omit<DiscardedBrowserTab, 'tabId'>[] {
  return Object.values(state.browserTabsByWorktree ?? {}).flatMap((tabs) =>
    tabs.flatMap((tab) => {
      const session = extensionSessionFor(tab)
      if (!session) {
        return []
      }
      return (state.browserPagesByWorkspace?.[tab.id] ?? []).flatMap((page) =>
        // A document page is no web page; a runtime-hosted page streams, never a local guest.
        page.docLocation || (page.remoteBrowserPageId && !page.remoteBrowserPageClientHosted)
          ? []
          : [{ browserPageId: page.id, url: page.url, title: page.title, session }]
      )
    })
  )
}

function savedPageIdsIn(hostIds: readonly string[]): Set<string> {
  return new Set(
    hostIds.flatMap((hostId) =>
      Object.values(source?.getWorkspaceSession(hostId).browserPagesByWorkspace ?? {}).flatMap(
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

/** Main's copy of the renderer's saved browser tabs; read on every listing, so never stale for long. */
export function setSavedBrowserTabsSource(next: SavedBrowserTabsSource | null): void {
  stopWatchingWrites?.()
  source = next
  stopWatchingWrites =
    next?.onWorkspaceSessionWritten((hostId) => {
      if (unloadedPageIds.size === 0) {
        return
      }
      const allHostIds = next.getWorkspaceSessionHostIds()
      const written = savedPageIdsIn(hostId ? [hostId] : allHostIds)
      const anywhere = savedPageIdsIn(allHostIds)
      for (const pageId of unloadedPageIds) {
        if (written.has(pageId) || !anywhere.has(pageId)) {
          unloadedPageIds.delete(pageId)
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
  for (const hostId of source.getWorkspaceSessionHostIds()) {
    for (const page of savedPagesIn(source.getWorkspaceSession(hostId))) {
      const { browserPageId } = page
      if (seen.has(browserPageId) || unloadedPageIds.has(browserPageId)) {
        continue
      }
      seen.add(browserPageId)
      if (hasLiveGuest(browserPageId)) {
        continue
      }
      let assigned = assignedByPageId.get(browserPageId)
      if (!assigned) {
        assigned = { tabId: nextTabId++, session: page.session }
        assignedByPageId.set(browserPageId, assigned)
      }
      tabs.push({ ...page, tabId: assigned.tabId })
    }
  }
  return tabs
}

export function findDiscardedBrowserTabForPage(browserPageId: string): DiscardedBrowserTab | null {
  return listDiscardedBrowserTabs().find((tab) => tab.browserPageId === browserPageId) ?? null
}

/** A page's guest registered: the synthetic id it was listed under (if any) retires with it. */
export function takeDiscardedBrowserTabId(
  browserPageId: string
): { tabId: number; session: Electron.Session } | null {
  const assigned = assignedByPageId.get(browserPageId) ?? null
  assignedByPageId.delete(browserPageId)
  return assigned
}

export function noteBrowserPageGuestGone(browserPageId: string): void {
  unloadedPageIds.add(browserPageId)
}

/** A restored renderer remounts from the saved session, so no guest loss there is a close. */
export function forgetBrowserPageGuestsGone(): void {
  unloadedPageIds.clear()
}
