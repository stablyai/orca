/// <reference types="chrome" />
import { webContents } from 'electron'
import { browserManager } from '../../browser-manager'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from '../browser-extension-api-host'
import { forgetBrowserExtensionActionTab } from '../browser-extension-action-registry'
import { revokeBrowserExtensionActiveTab } from '../browser-extension-active-tab'
import {
  noteBrowserPageGuestGone,
  takeDiscardedBrowserTabId
} from '../browser-extension-discarded-tabs'
import { isBrowserExtensionSupportEnabled } from '../browser-extension-support'
import {
  canExtensionSeeTabUrl,
  describeBrowserExtensionTab,
  replaceActivatedBrowserTabId,
  resolveBrowserExtensionTab
} from '../browser-extension-tab-model'
import { getBrowserExtensionMainWindow } from '../browser-extension-window-model'

/** Tabs announced through onCreated or onReplaced, with their window, so onRemoved matches them. */
const announcedTabWindowIds = new Map<number, { windowId: number; isPopout: boolean }>()
/** Page guests that changed before their registration said which page (and tab) they are. */
const unannouncedChanges = new Set<number>()
const pageIdByTabId = new Map<number, string>()

/** A page guest the renderer has not registered yet; it is announced on registration instead. */
function awaitsRegistration(contents: Electron.WebContents): boolean {
  return (
    contents.getType() === 'webview' &&
    browserManager.getTabIdForWebContentsId(contents.id) === null
  )
}

function emitTabUpdated(
  contents: Electron.WebContents,
  changeInfo: chrome.tabs.TabChangeInfo
): void {
  const tabId = contents.id
  if (!announcedTabWindowIds.has(tabId)) {
    unannouncedChanges.add(tabId)
    return
  }
  emitBrowserExtensionEvent({ session: contents.session }, 'tabs', 'onUpdated', (extension) => {
    const entry = resolveBrowserExtensionTab(tabId)
    if (!entry) {
      return null
    }
    const canSee = canExtensionSeeTabUrl(extension, contents.getURL(), tabId)
    const { url, title, ...visibleChange } = changeInfo
    if (!canSee && Object.keys(visibleChange).length === 0) {
      return null
    }
    return [
      tabId,
      canSee ? { ...visibleChange, url, title } : visibleChange,
      describeBrowserExtensionTab(extension, entry)
    ]
  })
}

/** Records the tab as announced; false when it is no tab or already was announced. */
function markAnnounced(contents: Electron.WebContents): boolean {
  const entry = resolveBrowserExtensionTab(contents.id)
  if (!entry || announcedTabWindowIds.has(contents.id)) {
    return false
  }
  announcedTabWindowIds.set(contents.id, {
    windowId: entry.windowId,
    isPopout: entry.windowType === 'popup'
  })
  return true
}

function emitTabCreated(contents: Electron.WebContents): void {
  emitBrowserExtensionEvent({ session: contents.session }, 'tabs', 'onCreated', (extension) => {
    const current = resolveBrowserExtensionTab(contents.id)
    return current ? [describeBrowserExtensionTab(extension, current)] : null
  })
}

function announceTab(contents: Electron.WebContents): void {
  if (!awaitsRegistration(contents) && markAnnounced(contents)) {
    emitTabCreated(contents)
  }
}

/**
 * The renderer registered a page's guest. A page listed as a discarded tab is that tab reloaded
 * under a new id (Chrome's onReplaced); any other page is a new tab.
 */
export function announceRegisteredBrowserExtensionTab(
  browserPageId: string,
  webContentsId: number
): void {
  const contents = webContents.fromId(webContentsId)
  if (!isBrowserExtensionSupportEnabled() || !contents || contents.isDestroyed()) {
    return
  }
  pageIdByTabId.set(webContentsId, browserPageId)
  const discarded = takeDiscardedBrowserTabId(browserPageId)
  const replaces = discarded?.session === contents.session
  if (discarded && !replaces) {
    // Loaded outside the session it was listed in, so that session's tab is simply gone.
    const windowId = getBrowserExtensionMainWindow()?.id ?? -1
    emitBrowserExtensionEvent({ session: discarded.session }, 'tabs', 'onRemoved', [
      discarded.tabId,
      { windowId, isWindowClosing: false }
    ])
  }
  if (!markAnnounced(contents)) {
    return
  }
  if (discarded && replaces) {
    replaceActivatedBrowserTabId(discarded.tabId, webContentsId)
    emitBrowserExtensionEvent({ session: contents.session }, 'tabs', 'onReplaced', [
      webContentsId,
      discarded.tabId
    ])
  } else {
    emitTabCreated(contents)
  }
  if (unannouncedChanges.delete(webContentsId)) {
    emitTabUpdated(contents, { status: contents.isLoading() ? 'loading' : 'complete' })
  }
}

/** tabs.onCreated / onUpdated / onRemoved for one tab webContents in an extension session. */
export function observeBrowserExtensionTabLifecycle(contents: Electron.WebContents): void {
  const tabId = contents.id
  const sess = contents.session
  contents.on('did-start-loading', () => {
    // Why the first load: a guest is a tab only once attached to Orca's window, and loads after that.
    announceTab(contents)
    emitTabUpdated(contents, { status: 'loading' })
  })
  contents.on('did-stop-loading', () => emitTabUpdated(contents, { status: 'complete' }))
  contents.on('did-navigate', (_event, url) => {
    revokeBrowserExtensionActiveTab(tabId)
    const profileId = getBrowserExtensionProfileIdForSession(sess)
    if (profileId) {
      forgetBrowserExtensionActionTab(profileId, tabId)
    }
    emitTabUpdated(contents, { url })
  })
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      emitTabUpdated(contents, { url })
    }
  })
  contents.on('page-title-updated', (_event, title) => emitTabUpdated(contents, { title }))
  contents.once('destroyed', () => {
    revokeBrowserExtensionActiveTab(tabId)
    const profileId = getBrowserExtensionProfileIdForSession(sess)
    if (profileId) {
      forgetBrowserExtensionActionTab(profileId, tabId)
    }
    unannouncedChanges.delete(tabId)
    const browserPageId = pageIdByTabId.get(tabId)
    pageIdByTabId.delete(tabId)
    if (browserPageId) {
      noteBrowserPageGuestGone(browserPageId)
    }
    // Why: only announced tabs; action popups and other extension windows are not tabs.
    const announced = announcedTabWindowIds.get(tabId)
    announcedTabWindowIds.delete(tabId)
    if (announced) {
      emitBrowserExtensionEvent({ session: sess }, 'tabs', 'onRemoved', [
        tabId,
        { windowId: announced.windowId, isWindowClosing: announced.isPopout }
      ])
    }
  })
}
