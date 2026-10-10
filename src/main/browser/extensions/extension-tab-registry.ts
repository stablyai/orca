import { BrowserWindow, type Session, type WebContents } from 'electron'
import { emitExtensionEvent, emitPerExtension } from './extension-api-host'
import {
  BROWSER_EXTENSION_ACTION_COMMANDS,
  findBrowserExtensionCommand
} from './extension-commands'
import { extensionCanSeeUrl } from './extension-match-pattern'
import { describeTab, describeWindow, WINDOW_ID_NONE } from './extension-tab-details'
import { watchWebNavigation } from './extension-web-navigation'
import { hasBrowserExtensions } from './extension-session-enabler'

/** How extensions act on Orca's browser tabs; wired by the browser manager. */
export type ExtensionTabHost = {
  /** Opens `url` as an Orca tab beside `nextTo`; false when that page has no Orca tab. */
  open(nextTo: WebContents, url: string, active: boolean): boolean
  close(tab: WebContents): void
  activate(tab: WebContents): void
}

type Tracked = {
  window: BrowserWindow
  renderer: WebContents
  // Why copies: untracking runs on 'destroyed', when reading the tab or window throws.
  session: Session
  tabId: number
  windowId: number
  untrack: () => void
}

const NEW_TAB_TIMEOUT_MS = 15_000
const tracked = new Map<WebContents, Tracked>()
const activeByWindow = new Map<BrowserWindow, WebContents>()
const sessionsByWindow = new Map<BrowserWindow, Set<Session>>()
const popupWindows = new WeakSet<BrowserWindow>()
let waitingForTab: ((tab: WebContents) => void)[] = []
let host: ExtensionTabHost | null = null
let lastTab: WebContents | null = null
let lastFocusedWindow: BrowserWindow | null = null

export function setExtensionTabHost(next: ExtensionTabHost): void {
  host = next
}

/**
 * Makes a page an extension tab: chrome.tabs sees it, its key presses run extension shortcuts, and
 * its loads fire tab events. Call after Orca's own input listeners, and again if the page moves.
 */
export function trackExtensionTab(tab: WebContents, renderer: WebContents): void {
  if (!hasBrowserExtensions(tab.session)) {
    return
  }
  const window = BrowserWindow.fromWebContents(renderer)
  if (!window) {
    return
  }
  const previous = tracked.get(tab)
  previous?.untrack()
  const session = tab.session
  watchWindow(window, session)
  const updated = (change: Record<string, unknown>): void =>
    emitPerExtension(session, 'tabs.onUpdated', (extension) => [
      tab.id,
      extensionCanSeeUrl(extension, tab.getURL()) ? change : { status: change.status },
      tabDetails(tab, extension)
    ])
  // Why a plain emitter: these listeners are kept by name so untracking can remove them.
  const emitter: NodeJS.EventEmitter = tab
  const listeners: Record<string, (...args: any[]) => void> = {
    focus: () => markExtensionTabActive(tab),
    'before-input-event': (event: Electron.Event, input: Electron.Input) =>
      void runExtensionShortcut(tab, event, input),
    'did-start-loading': () => updated({ status: 'loading' }),
    'did-stop-loading': () => updated({ status: 'complete' }),
    'did-navigate': (_event: Electron.Event, url: string) => updated({ url }),
    'did-navigate-in-page': (_event: Electron.Event, url: string, isMainFrame: boolean) =>
      isMainFrame && updated({ url }),
    'page-title-updated': (_event: Electron.Event, title: string) => updated({ title }),
    'page-favicon-updated': (_event: Electron.Event, icons: string[]) =>
      updated({ favIconUrl: icons[0] })
  }
  for (const [name, listener] of Object.entries(listeners)) {
    emitter.on(name, listener)
  }
  tracked.set(tab, {
    window,
    renderer,
    session,
    tabId: tab.id,
    windowId: window.id,
    untrack: () => {
      for (const [name, listener] of Object.entries(listeners)) {
        emitter.off(name, listener)
      }
    }
  })
  if (!activeByWindow.has(window) || tab.isFocused()) {
    markExtensionTabActive(tab)
  }
  if (!previous) {
    watchWebNavigation(tab)
    tab.once('destroyed', () => untrackExtensionTab(tab))
    emitPerExtension(session, 'tabs.onCreated', (extension) => [tabDetails(tab, extension)])
    waitingForTab.shift()?.(tab)
  }
}

export function untrackExtensionTab(tab: WebContents): void {
  const entry = tracked.get(tab)
  if (!entry) {
    return
  }
  entry.untrack()
  tracked.delete(tab)
  if (lastTab === tab) {
    lastTab = null
  }
  if (activeByWindow.get(entry.window) === tab) {
    activeByWindow.delete(entry.window)
  }
  emitExtensionEventToAll(entry.session, 'tabs.onRemoved', [
    entry.tabId,
    { windowId: entry.windowId, isWindowClosing: entry.window.isDestroyed() }
  ])
}

/** An extension popup window: its page counts as the window's one tab. */
export function trackExtensionPopupWindow(window: BrowserWindow): void {
  popupWindows.add(window)
  trackExtensionTab(window.webContents, window.webContents)
}

export function isExtensionPopupWindow(window: BrowserWindow): boolean {
  return popupWindows.has(window)
}

function emitExtensionEventToAll(session: Session, key: string, args: unknown[]): void {
  emitPerExtension(session, key, () => args)
}

/** The tab the user is on in its window: Orca's tab switch, or focus moving into the page. */
export function markExtensionTabActive(tab: WebContents): void {
  const entry = tracked.get(tab)
  if (!entry) {
    return
  }
  lastTab = tab
  if (activeByWindow.get(entry.window) === tab) {
    return
  }
  activeByWindow.set(entry.window, tab)
  const windowId = entry.windowId
  emitExtensionEventToAll(tab.session, 'tabs.onActivated', [{ tabId: tab.id, windowId }])
  emitExtensionEventToAll(tab.session, 'tabs.onHighlighted', [{ tabIds: [tab.id], windowId }])
}

function watchWindow(window: BrowserWindow, session: Session): void {
  const sessions = sessionsByWindow.get(window)
  if (sessions) {
    if (!sessions.has(session)) {
      sessions.add(session)
      emitExtensionEventToAll(session, 'windows.onCreated', [windowDetails(window, null)])
    }
    return
  }
  sessionsByWindow.set(window, new Set([session]))
  emitExtensionEventToAll(session, 'windows.onCreated', [windowDetails(window, null)])
  const focusChanged = (windowId: number): void => {
    for (const each of sessionsByWindow.get(window) ?? []) {
      emitExtensionEventToAll(each, 'windows.onFocusChanged', [windowId])
    }
  }
  window.on('focus', () => {
    lastFocusedWindow = window
    focusChanged(window.id)
  })
  window.on('blur', () => focusChanged(WINDOW_ID_NONE))
  window.once('closed', () => {
    for (const each of sessionsByWindow.get(window) ?? []) {
      emitExtensionEventToAll(each, 'windows.onRemoved', [window.id])
    }
    sessionsByWindow.delete(window)
    activeByWindow.delete(window)
    if (lastFocusedWindow === window) {
      lastFocusedWindow = null
    }
  })
}

/**
 * Runs the extension shortcut `input` presses in `tab`, if any; true when one ran. Pages whose keys
 * skip before-input-event (offscreen pages get theirs over CDP) call this from their key path.
 */
export function runExtensionShortcut(
  tab: WebContents,
  event: Electron.Event,
  input: Electron.Input
): boolean {
  // Why: an Orca shortcut on the same keys already claimed the press; Chrome also lets the browser win.
  if (event.defaultPrevented || !tracked.has(tab)) {
    return false
  }
  const extensions = tab.session.extensions.getAllExtensions()
  const command = findBrowserExtensionCommand(extensions, input, process.platform)
  if (!command) {
    return false
  }
  event.preventDefault()
  if (BROWSER_EXTENSION_ACTION_COMMANDS.has(command.name)) {
    requestExtensionAction(tab, command.extensionId)
    return true
  }
  const extension = tab.session.extensions.getExtension(command.extensionId)
  emitExtensionEvent(
    tab.session,
    'commands.onCommand',
    [command.name, tabDetails(tab, extension)],
    command.extensionId
  )
  return true
}

/** Clicks the extension's toolbar button for `tab`: the button anchors the popup, so its renderer opens it. */
export function requestExtensionAction(tab: WebContents, extensionId: string): boolean {
  const renderer = tracked.get(tab)?.renderer
  if (!renderer || renderer === tab || renderer.isDestroyed()) {
    return false
  }
  renderer.send('browser:extension-action-requested', { tabId: tab.id, extensionId })
  return true
}

/** The Orca windows' renderers showing tabs of `session`, which draw its extension toolbar. */
export function extensionToolbarRenderers(session: Session): Set<WebContents> {
  const renderers = new Set<WebContents>()
  for (const [tab, entry] of tracked) {
    if (tab.session === session && entry.renderer !== tab && !entry.renderer.isDestroyed()) {
      renderers.add(entry.renderer)
    }
  }
  return renderers
}

/** The page the user last used, or null once it is gone. */
export function lastExtensionTab(): WebContents | null {
  return lastTab && !lastTab.isDestroyed() ? lastTab : null
}

/** The session's tabs, in the order Orca registered them. */
export function extensionTabs(session: Session): WebContents[] {
  return [...tracked.keys()].filter((tab) => tab.session === session && !tab.isDestroyed())
}

export function isExtensionTab(tab: WebContents): boolean {
  return tracked.has(tab)
}

export function tabDetails(
  tab: WebContents,
  extension: Electron.Extension | null
): Record<string, unknown> {
  const window = tracked.get(tab)?.window
  if (!window) {
    return { id: tab.id, index: -1, windowId: WINDOW_ID_NONE, active: false }
  }
  const siblings = extensionTabs(tab.session).filter((each) => tracked.get(each)?.window === window)
  const placement = {
    window,
    index: siblings.indexOf(tab),
    active: activeByWindow.get(window) === tab
  }
  return describeTab(tab, placement, extension)
}

export function extensionWindows(session: Session): BrowserWindow[] {
  return [...sessionsByWindow]
    .filter(([window, sessions]) => sessions.has(session) && !window.isDestroyed())
    .map(([window]) => window)
}

export function windowDetails(
  window: BrowserWindow,
  tabsOf: { session: Session; extension: Electron.Extension } | null
): Record<string, unknown> {
  const tabs = tabsOf
    ? extensionTabs(tabsOf.session)
        .filter((tab) => tracked.get(tab)?.window === window)
        .map((tab) => tabDetails(tab, tabsOf.extension))
    : null
  return describeWindow(window, popupWindows.has(window) ? 'popup' : 'normal', tabs)
}

export function tabWindow(tab: WebContents): BrowserWindow | null {
  return tracked.get(tab)?.window ?? null
}

export function activeTabOf(window: BrowserWindow): WebContents | null {
  return activeByWindow.get(window) ?? null
}

/** The window the user last focused that holds tabs of `session`. */
export function lastFocusedExtensionWindow(session: Session): BrowserWindow | null {
  const windows = extensionWindows(session)
  return (
    (lastFocusedWindow && windows.includes(lastFocusedWindow) ? lastFocusedWindow : windows[0]) ??
    null
  )
}

export function closeExtensionTab(tab: WebContents): void {
  const window = tracked.get(tab)?.window
  if (window && popupWindows.has(window)) {
    window.close()
  } else {
    host?.close(tab)
  }
}

export function activateExtensionTab(tab: WebContents): void {
  host?.activate(tab)
}

/** chrome.tabs.create: a new Orca tab beside the page the user last used. */
export function openExtensionTab(url: string, active: boolean): Promise<WebContents> {
  return new Promise((resolve, reject) => {
    const stopWaiting = (): void => {
      clearTimeout(timer)
      waitingForTab = waitingForTab.filter((waiter) => waiter !== onTab)
    }
    const timer = setTimeout(() => {
      stopWaiting()
      reject(new Error('Orca did not open the tab'))
    }, NEW_TAB_TIMEOUT_MS)
    const onTab = (tab: WebContents): void => {
      clearTimeout(timer)
      resolve(tab)
    }
    waitingForTab.push(onTab)
    const nextTo = lastExtensionTab()
    if (!nextTo || !host?.open(nextTo, url, active)) {
      stopWaiting()
      reject(new Error('No Orca browser tab to open the page next to'))
    }
  })
}
