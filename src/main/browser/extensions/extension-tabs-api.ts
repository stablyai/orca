import { BrowserWindow, webContents, type WebContents } from 'electron'
import { handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import {
  extensionUrl,
  numberArg,
  objectArg,
  optionalNumber,
  optionalString
} from './extension-api-args'
import { extensionCanSeeUrl, globToRegExp, matchesUrlPattern } from './extension-match-pattern'
import { WINDOW_ID_CURRENT } from './extension-tab-details'
import { presentExtensionWindow } from './extension-action-state'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import {
  activateExtensionTab,
  activeTabOf,
  closeExtensionTab,
  extensionTabs,
  extensionWindows,
  isExtensionPopupWindow,
  isExtensionTab,
  lastFocusedExtensionWindow,
  openExtensionTab,
  tabDetails,
  tabWindow,
  trackExtensionPopupWindow,
  windowDetails
} from './extension-tab-registry'

function findTab(caller: ExtensionCaller, tabId: unknown): WebContents {
  const id = numberArg(tabId, 'tabId')
  const tab = extensionTabs(caller.session).find((each) => each.id === id)
  if (!tab) {
    throw new Error(`No tab with id: ${id}`)
  }
  return tab
}

/** The window a call comes from: its tab's, a popup's opener, or the one last focused. */
function callerWindow(caller: ExtensionCaller): BrowserWindow | null {
  const contents = caller.frame && webContents.fromFrame(caller.frame)
  const window = contents && (tabWindow(contents) ?? BrowserWindow.fromWebContents(contents))
  return window?.getParentWindow() ?? window ?? lastFocusedExtensionWindow(caller.session)
}

function findWindow(caller: ExtensionCaller, windowId: unknown): BrowserWindow {
  const id = numberArg(windowId, 'windowId')
  const window =
    id === WINDOW_ID_CURRENT
      ? callerWindow(caller)
      : extensionWindows(caller.session).find((each) => each.id === id)
  if (!window) {
    throw new Error(`No window with id: ${id}`)
  }
  return window
}

function describe(caller: ExtensionCaller, tab: WebContents): Record<string, unknown> {
  return tabDetails(tab, caller.extension)
}

function matchesQuery(
  caller: ExtensionCaller,
  tab: WebContents,
  query: Record<string, unknown>
): boolean {
  const details = describe(caller, tab)
  const window = tabWindow(tab)
  const wantedWindow =
    query.currentWindow === true || query.windowId === WINDOW_ID_CURRENT
      ? callerWindow(caller)
      : query.lastFocusedWindow === true
        ? lastFocusedExtensionWindow(caller.session)
        : undefined
  const urls = [query.url].flat().filter((url): url is string => typeof url === 'string')
  const url = tab.getURL()
  return (
    (wantedWindow === undefined || window === wantedWindow) &&
    (typeof query.windowId !== 'number' ||
      query.windowId === WINDOW_ID_CURRENT ||
      window?.id === query.windowId) &&
    (typeof query.active !== 'boolean' || details.active === query.active) &&
    (typeof query.highlighted !== 'boolean' || details.highlighted === query.highlighted) &&
    (typeof query.status !== 'string' || details.status === query.status) &&
    (typeof query.index !== 'number' || details.index === query.index) &&
    (typeof query.audible !== 'boolean' || details.audible === query.audible) &&
    query.pinned !== true &&
    (urls.length === 0 ||
      (extensionCanSeeUrl(caller.extension, url) &&
        urls.some((pattern) => matchesUrlPattern(pattern, url)))) &&
    (typeof query.title !== 'string' ||
      (typeof details.title === 'string' && globToRegExp(query.title).test(details.title)))
  )
}

function populate(caller: ExtensionCaller, info: unknown) {
  return objectArg(info).populate === true
    ? { session: caller.session, extension: caller.extension }
    : null
}

handleExtensionApi('tabs', {
  get: (caller: ExtensionCaller, tabId: unknown) => describe(caller, findTab(caller, tabId)),
  getCurrent: (caller: ExtensionCaller) => {
    const contents = caller.frame && webContents.fromFrame(caller.frame)
    return contents && isExtensionTab(contents) ? describe(caller, contents) : undefined
  },
  query: (caller: ExtensionCaller, queryInfo: unknown) => {
    const query = objectArg(queryInfo)
    return extensionTabs(caller.session)
      .filter((tab) => matchesQuery(caller, tab, query))
      .map((tab) => describe(caller, tab))
  },
  create: async (caller: ExtensionCaller, createProperties: unknown) => {
    const properties = objectArg(createProperties)
    const url =
      properties.url === undefined ? 'about:blank' : extensionUrl(caller.extension, properties.url)
    return describe(caller, await openExtensionTab(url, properties.active !== false))
  },
  update: async (caller: ExtensionCaller, first: unknown, second: unknown) => {
    // update(tabId?, properties): without an id it acts on the current window's active tab.
    const hasId = typeof first === 'number'
    const properties = objectArg(hasId ? second : first)
    const window = callerWindow(caller)
    const tab = hasId ? findTab(caller, first) : window && activeTabOf(window)
    if (!tab) {
      throw new Error('No active tab')
    }
    if (properties.url !== undefined) {
      await tab.loadURL(extensionUrl(caller.extension, properties.url))
    }
    if (typeof properties.muted === 'boolean') {
      tab.setAudioMuted(properties.muted)
    }
    if (properties.active === true || properties.highlighted === true) {
      activateExtensionTab(tab)
    }
    return describe(caller, tab)
  },
  remove: (caller: ExtensionCaller, tabIds: unknown) => {
    for (const id of [tabIds].flat()) {
      closeExtensionTab(findTab(caller, id))
    }
  }
})

handleExtensionApi('windows', {
  get: (caller: ExtensionCaller, windowId: unknown, info: unknown) =>
    windowDetails(findWindow(caller, windowId), populate(caller, info)),
  getCurrent: (caller: ExtensionCaller, info: unknown) =>
    windowDetails(findWindow(caller, WINDOW_ID_CURRENT), populate(caller, info)),
  getLastFocused: (caller: ExtensionCaller, info: unknown) => {
    const window = lastFocusedExtensionWindow(caller.session)
    if (!window) {
      throw new Error('No window')
    }
    return windowDetails(window, populate(caller, info))
  },
  getAll: (caller: ExtensionCaller, info: unknown) =>
    extensionWindows(caller.session).map((window) => windowDetails(window, populate(caller, info))),
  create: async (caller: ExtensionCaller, createData: unknown) => {
    const data = objectArg(createData)
    const url = [data.url].flat()[0]
    const resolved = url === undefined ? 'about:blank' : extensionUrl(caller.extension, url)
    if (data.type !== 'popup' && data.type !== 'panel') {
      // A "normal" window is an Orca tab: Orca's windows hold workspaces, not bare pages.
      const tab = await openExtensionTab(resolved, data.focused !== false)
      const window = tabWindow(tab)
      return (
        window && windowDetails(window, { session: caller.session, extension: caller.extension })
      )
    }
    const window = new BrowserWindow({
      width: optionalNumber(data.width) ?? 500,
      height: optionalNumber(data.height) ?? 600,
      x: optionalNumber(data.left),
      y: optionalNumber(data.top),
      title: optionalString(data.title),
      show: false,
      webPreferences: { session: caller.session }
    })
    presentExtensionWindow(window)
    trackExtensionPopupWindow(window)
    void window.loadURL(resolved)
    return windowDetails(window, { session: caller.session, extension: caller.extension })
  },
  update: (caller: ExtensionCaller, windowId: unknown, updateInfo: unknown) => {
    const window = findWindow(caller, windowId)
    const info = objectArg(updateInfo)
    if (info.state === 'minimized') {
      window.minimize()
    } else if (info.state === 'maximized') {
      window.maximize()
    } else if (info.state === 'fullscreen') {
      window.setFullScreen(true)
    } else if (info.state === 'normal') {
      window.setFullScreen(false)
      window.restore()
    }
    if (isExtensionPopupWindow(window)) {
      const bounds = window.getBounds()
      window.setBounds({
        x: optionalNumber(info.left) ?? bounds.x,
        y: optionalNumber(info.top) ?? bounds.y,
        width: optionalNumber(info.width) ?? bounds.width,
        height: optionalNumber(info.height) ?? bounds.height
      })
    }
    // Why: a background run must never take the foreground.
    if (info.focused === true && !isBackgroundLaunch()) {
      window.focus()
    }
    return windowDetails(window, null)
  },
  remove: (caller: ExtensionCaller, windowId: unknown) => {
    const window = findWindow(caller, windowId)
    // Why: an Orca window holds the user's workspaces; only windows extensions opened are theirs.
    if (!isExtensionPopupWindow(window)) {
      throw new Error('Orca windows cannot be closed by extensions')
    }
    window.close()
  }
})
