/// <reference types="chrome" />
import { activateBrowserTabInRenderer } from '../../runtime/browser/browser-tab-renderer-activate'
import { closeBrowserTabInRenderer } from '../../runtime/browser/browser-tab-renderer-close'
import { BrowserExtensionApiError } from './browser-extension-namespace-registry'
import {
  FIRST_DISCARDED_BROWSER_TAB_ID,
  listDiscardedBrowserTabs,
  type DiscardedBrowserTab
} from './browser-extension-discarded-tabs'
import {
  canExtensionSeeTabUrl,
  getActiveBrowserTabId,
  mainWindowTabIds
} from './browser-extension-tab-model'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'

/** A discarded tab sits in the main window after every loaded one. */
export type BrowserExtensionDiscardedTabEntry = {
  tab: DiscardedBrowserTab
  windowId: number
  index: number
  active: boolean
}

export function listBrowserExtensionDiscardedTabs(
  sess: Electron.Session
): BrowserExtensionDiscardedTabEntry[] {
  const mainWindow = getBrowserExtensionMainWindow()
  if (!mainWindow) {
    return []
  }
  const loadedCount = mainWindowTabIds().length
  const activeId = getActiveBrowserTabId()
  return listDiscardedBrowserTabs().flatMap((tab, offset) =>
    tab.session === sess
      ? [
          {
            tab,
            windowId: mainWindow.id,
            index: loadedCount + offset,
            active: tab.tabId === activeId
          }
        ]
      : []
  )
}

export function findBrowserExtensionDiscardedTab(
  sess: Electron.Session,
  tabId: number
): BrowserExtensionDiscardedTabEntry | null {
  return tabId < FIRST_DISCARDED_BROWSER_TAB_ID
    ? null
    : (listBrowserExtensionDiscardedTabs(sess).find((entry) => entry.tab.tabId === tabId) ?? null)
}

export function describeBrowserExtensionDiscardedTab(
  extension: Electron.Extension,
  entry: BrowserExtensionDiscardedTabEntry
): chrome.tabs.Tab {
  const { tab, active } = entry
  return {
    id: tab.tabId,
    index: entry.index,
    windowId: entry.windowId,
    active,
    highlighted: active,
    selected: active,
    pinned: false,
    discarded: true,
    autoDiscardable: true,
    incognito: false,
    groupId: -1,
    status: 'unloaded',
    audible: false,
    mutedInfo: { muted: false },
    ...(canExtensionSeeTabUrl(extension, tab.session, tab.url, tab.tabId)
      ? { url: tab.url, title: tab.title }
      : {})
  }
}

function requireMainWindow(entry: BrowserExtensionDiscardedTabEntry): Electron.BrowserWindow {
  const mainWindow = getBrowserExtensionMainWindow()
  if (!mainWindow) {
    throw new BrowserExtensionApiError(`No tab with id: ${entry.tab.tabId}.`)
  }
  return mainWindow
}

/** Showing the page mounts its guest, which loads it; the tab then reports onReplaced. */
export async function activateBrowserExtensionDiscardedTab(
  entry: BrowserExtensionDiscardedTabEntry
): Promise<void> {
  await activateBrowserTabInRenderer(requireMainWindow(entry), entry.tab.browserPageId)
}

export async function closeBrowserExtensionDiscardedTab(
  entry: BrowserExtensionDiscardedTabEntry
): Promise<void> {
  await closeBrowserTabInRenderer(requireMainWindow(entry), entry.tab.browserPageId, undefined)
}
