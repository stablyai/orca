/// <reference types="chrome" />
import { webContents } from 'electron'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import { browserManager } from '../browser-manager'
import { createBrowserTabInRenderer } from '../../runtime/browser/browser-tab-renderer-create'
import { closeBrowserTabInRenderer } from '../../runtime/browser/browser-tab-renderer-close'
import { activateBrowserTabInRenderer } from '../../runtime/browser/browser-tab-renderer-activate'
import { waitForTabRegistration } from '../../ipc/browser-tab-registration-wait'
import { emitBrowserExtensionEvent } from './browser-extension-api-host'
import {
  BrowserExtensionApiError,
  extensionHasPermission,
  type BrowserExtensionCaller
} from './browser-extension-namespace-registry'
import { hasBrowserExtensionHostPermission } from './browser-extension-permission-grants'
import { browserExtensionHostPatternsInSession } from './api/permissions'
import { closeBrowserExtensionPopup } from './browser-extension-popup-host'
import { hasBrowserExtensionActiveTab } from './browser-extension-active-tab'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionSessionForProfile
} from './browser-extension-session-loader'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { whenBrowserExtensionMainWindowReady } from './browser-extension-main-window-readiness'
import { findDiscardedBrowserTabForPage } from './browser-extension-discarded-tabs'
import {
  getBrowserExtensionMainWindow,
  getLastFocusedBrowserExtensionWindowId,
  getPopoutWindowForWebContents,
  listPopoutWindowsInSession,
  presentBrowserExtensionWindow
} from './browser-extension-window-model'

/**
 * Chrome tab id = the guest webContents id, which keeps Electron's own tabs.sendMessage and
 * scripting consistent. Every Orca browser tab sits in the main window; a popout is a window
 * holding exactly one tab (its page).
 */
export type BrowserExtensionTabEntry = {
  contents: Electron.WebContents
  windowId: number
  windowType: 'normal' | 'popup'
  index: number
  active: boolean
}

/** How long an extension's new tab waits for Orca's window and its restored workspaces. */
const MAIN_WINDOW_WAIT_MS = 30_000

let activeBrowserPageId: string | null = null
let lastActivatedTabId: number | null = null

function liveContents(id: number | null | undefined): Electron.WebContents | null {
  const contents = id == null ? undefined : webContents.fromId(id)
  return contents && !contents.isDestroyed() ? contents : null
}

/** Fed by the renderer's browser:activeTabChanged; the single answer to `active: true`. */
export function recordActiveBrowserPage(browserPageId: string): void {
  const pageChanged = browserPageId !== activeBrowserPageId
  activeBrowserPageId = browserPageId
  if (pageChanged && isBrowserExtensionSupportEnabled()) {
    // Why: Chrome's action popup belongs to the tab it opened on.
    closeBrowserExtensionPopup()
  }
  const tabId = getActiveBrowserTabId()
  const windowId = getBrowserExtensionMainWindow()?.id
  if (!isBrowserExtensionSupportEnabled() || tabId === null || tabId === lastActivatedTabId) {
    return
  }
  lastActivatedTabId = tabId
  if (windowId !== undefined) {
    const sess =
      liveContents(tabId)?.session ?? findDiscardedBrowserTabForPage(browserPageId)?.session
    emitBrowserExtensionEvent({ session: sess }, 'tabs', 'onActivated', [{ tabId, windowId }])
  }
}

/** A discarded active tab loaded under a new id; Chrome announces that as onReplaced, not onActivated. */
export function replaceActivatedBrowserTabId(removedTabId: number, addedTabId: number): void {
  if (lastActivatedTabId === removedTabId) {
    lastActivatedTabId = addedTabId
  }
}

/** The active page's tab: its guest, else (shown but not yet loaded) its discarded tab. */
export function getActiveBrowserTabId(): number | null {
  if (!activeBrowserPageId) {
    return null
  }
  return (
    liveContents(browserManager.getGuestWebContentsId(activeBrowserPageId))?.id ??
    findDiscardedBrowserTabForPage(activeBrowserPageId)?.tabId ??
    null
  )
}

export function mainWindowTabIds(): number[] {
  return [...browserManager.getWebContentsIdByTabId().values()].filter((id) => liveContents(id))
}

export function resolveBrowserExtensionTab(tabId: number): BrowserExtensionTabEntry | null {
  const contents = liveContents(tabId)
  if (!contents) {
    return null
  }
  const popout = getPopoutWindowForWebContents(contents)
  if (popout) {
    return { contents, windowId: popout.id, windowType: 'popup', index: 0, active: true }
  }
  const mainWindow = getBrowserExtensionMainWindow()
  const tabIds = mainWindowTabIds()
  const index = tabIds.indexOf(tabId)
  // Why the host check: a page's first script runs before the renderer registers its guest.
  const isMainWindowGuest =
    contents.getType() === 'webview' && contents.hostWebContents === mainWindow?.webContents
  if (!mainWindow || (index === -1 && !isMainWindowGuest)) {
    return null
  }
  return {
    contents,
    windowId: mainWindow.id,
    windowType: 'normal',
    index: index === -1 ? tabIds.length : index,
    active: tabId === getActiveBrowserTabId()
  }
}

/** Tabs an extension in this session can address: Orca tabs in the session plus its popouts. */
export function listBrowserExtensionTabs(sess: Electron.Session): BrowserExtensionTabEntry[] {
  const ids = [
    ...mainWindowTabIds(),
    ...listPopoutWindowsInSession(sess).map((window) => window.webContents.id)
  ]
  return ids.flatMap((id) => {
    const entry = resolveBrowserExtensionTab(id)
    return entry && entry.contents.session === sess ? [entry] : []
  })
}

/** A tab the caller may touch: it must live in the caller's session. */
export function requireCallerTab(
  caller: BrowserExtensionCaller,
  tabId: number
): BrowserExtensionTabEntry {
  const entry = resolveBrowserExtensionTab(tabId)
  if (!entry || entry.contents.session !== caller.session) {
    throw new BrowserExtensionApiError(`No tab with id: ${tabId}.`)
  }
  return entry
}

export function resolveCallerWindowId(caller: BrowserExtensionCaller): number | null {
  if (caller.webContents) {
    const popout = getPopoutWindowForWebContents(caller.webContents)
    if (popout) {
      return popout.id
    }
    return getBrowserExtensionMainWindow()?.id ?? null
  }
  // Chrome: a background context's "current" window is the last focused one.
  return getLastFocusedBrowserExtensionWindowId(caller.session)
}

/** Chrome shows url/title with "tabs" or a matching host permission, optional grants included. */
export function canExtensionSeeTabUrl(
  extension: Electron.Extension,
  sess: Electron.Session,
  url: string,
  tabId?: number
): boolean {
  return (
    url.startsWith(`${getChromeExtensionOrigin(extension.id)}/`) ||
    extensionHasPermission(extension, 'tabs', sess) ||
    (tabId !== undefined && hasBrowserExtensionActiveTab(extension.id, tabId)) ||
    hasBrowserExtensionHostPermission(browserExtensionHostPatternsInSession(extension, sess), url)
  )
}

function tabStatus(contents: Electron.WebContents): 'loading' | 'complete' {
  return contents.isLoading() ? 'loading' : 'complete'
}

/** The fields Orca owns; url/title come from Electron's native result or describeBrowserExtensionTab. */
function orcaTabFields(entry: BrowserExtensionTabEntry): chrome.tabs.Tab {
  const { contents } = entry
  return {
    id: contents.id,
    index: entry.index,
    windowId: entry.windowId,
    active: entry.active,
    highlighted: entry.active,
    selected: entry.active,
    pinned: false,
    discarded: false,
    autoDiscardable: true,
    incognito: false,
    groupId: -1,
    status: tabStatus(contents),
    audible: contents.isCurrentlyAudible(),
    mutedInfo: { muted: contents.isAudioMuted() }
  }
}

export function describeBrowserExtensionTab(
  extension: Electron.Extension,
  entry: BrowserExtensionTabEntry
): chrome.tabs.Tab {
  const url = entry.contents.getURL()
  return {
    ...orcaTabFields(entry),
    ...(canExtensionSeeTabUrl(extension, entry.contents.session, url, entry.contents.id)
      ? { url, title: entry.contents.getTitle() }
      : {})
  }
}

/** Keeps Electron's native fields (url/title gated by its own permission check) and adds Orca's. */
export function mergeNativeTab(
  nativeTab: Record<string, unknown>,
  entry: BrowserExtensionTabEntry
): chrome.tabs.Tab {
  const native: Partial<chrome.tabs.Tab> = {}
  for (const key of [
    'url',
    'title',
    'favIconUrl',
    'lastAccessed',
    'audible',
    'mutedInfo'
  ] as const) {
    if (nativeTab[key] !== undefined) {
      Object.assign(native, { [key]: nativeTab[key] })
    }
  }
  return { ...orcaTabFields(entry), ...native }
}

/**
 * The workspace this profile's tabs were last used in: the active page's, else any open tab's.
 * Used only when no workspace is active, so an extension tab still has somewhere to go.
 */
export function recentWorktreeIdForBrowserProfile(profileId: string): string | undefined {
  const sess = getBrowserExtensionSessionForProfile(profileId)
  if (!sess) {
    return undefined
  }
  const pageIds = [
    ...(activeBrowserPageId ? [activeBrowserPageId] : []),
    ...browserManager.getWebContentsIdByTabId().keys()
  ]
  for (const pageId of pageIds) {
    const contents = liveContents(browserManager.getGuestWebContentsId(pageId))
    const worktreeId = browserManager.getWorktreeIdForTab(pageId)
    if (contents?.session === sess && worktreeId) {
      return worktreeId
    }
  }
  return undefined
}

/** Opens a tab through Orca's renderer-owned tab path, in the caller's browser profile. */
export async function openBrowserExtensionTab(
  browserProfileId: string,
  url: string,
  active: boolean
): Promise<number> {
  const profile = getBrowserExtensionProfile(browserProfileId)
  // Why wait: extensions open tabs as they load (onInstalled), before Orca's window can take them.
  const mainWindow = profile ? await whenBrowserExtensionMainWindowReady(MAIN_WINDOW_WAIT_MS) : null
  if (!mainWindow || !profile) {
    throw new BrowserExtensionApiError('Orca has no window to open a tab in')
  }
  const { browserPageId } = await createBrowserTabInRenderer(
    { getAuthoritativeWindow: () => mainWindow },
    url,
    undefined,
    profile.id,
    profile.partition,
    active,
    undefined,
    recentWorktreeIdForBrowserProfile(profile.id)
  )
  await waitForTabRegistration(browserPageId)
  const tabId = browserManager.getGuestWebContentsId(browserPageId)
  if (tabId === null) {
    throw new BrowserExtensionApiError('The new tab did not finish opening')
  }
  return tabId
}

/** Closes through Orca's close path (pinned-tab guard included); popout tabs close their window. */
export async function closeBrowserExtensionTab(entry: BrowserExtensionTabEntry): Promise<void> {
  const popout = getPopoutWindowForWebContents(entry.contents)
  if (popout) {
    popout.close()
    return
  }
  const browserPageId = browserManager.getTabIdForWebContentsId(entry.contents.id)
  const mainWindow = getBrowserExtensionMainWindow()
  if (!browserPageId || !mainWindow) {
    throw new BrowserExtensionApiError(`No tab with id: ${entry.contents.id}.`)
  }
  await closeBrowserTabInRenderer(mainWindow, browserPageId, undefined)
}

/** tabs.update({active}): Orca tabs activate through the renderer's tab model; a popout's tab is its window. */
export async function activateBrowserExtensionTab(entry: BrowserExtensionTabEntry): Promise<void> {
  const popout = getPopoutWindowForWebContents(entry.contents)
  if (popout) {
    presentBrowserExtensionWindow(popout, true)
    return
  }
  const browserPageId = browserManager.getTabIdForWebContentsId(entry.contents.id)
  const mainWindow = getBrowserExtensionMainWindow()
  if (!browserPageId || !mainWindow) {
    throw new BrowserExtensionApiError(`No tab with id: ${entry.contents.id}.`)
  }
  await activateBrowserTabInRenderer(mainWindow, browserPageId)
}
