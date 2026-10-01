import { BrowserWindow, nativeImage, screen, type WebContents } from 'electron'
import type { BrowserExtensionActionAnchor } from '../../../shared/browser-guest-events'
import { isWindowlessLaunch } from '../../window/foreground-activation-policy'
import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { extensionUrl, objectArg, optionalNumber } from './extension-api-args'
import {
  extensionIconDataUrl,
  parseBadgeColor,
  readAction,
  writeAction
} from './extension-action-state'
import {
  extensionTabs,
  lastExtensionTab,
  requestExtensionAction,
  tabDetails
} from './extension-tab-registry'

const POPUP_MIN = { width: 25, height: 25 }
const POPUP_MAX = { width: 800, height: 600 }
const TOGGLE_WINDOW_MS = 300
let openPopup: BrowserWindow | null = null
let lastClosed: { extensionId: string; at: number } | null = null

function findTab(caller: ExtensionCaller, tabId: number | undefined): WebContents | undefined {
  if (tabId === undefined) {
    return undefined
  }
  const tab = extensionTabs(caller.session).find((each) => each.id === tabId)
  if (!tab) {
    throw new Error(`No tab with id: ${tabId}`)
  }
  return tab
}

/** A setter taking `{ tabId?, <key> }`, as every chrome.action setter does. */
function setter(key: string, apply: (caller: ExtensionCaller, value: unknown) => object) {
  return (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const tab = findTab(caller, optionalNumber(args.tabId))
    writeAction(caller.session, caller.extension, tab, apply(caller, args[key]))
  }
}

function getter(field: Parameters<typeof readAction>[2]) {
  return (caller: ExtensionCaller, details: unknown) =>
    readAction(caller.session, caller.extension, field, optionalNumber(objectArg(details).tabId))
}

function iconFromDetails(caller: ExtensionCaller, details: Record<string, unknown>) {
  // The preload hands ImageData over as PNG bytes; see browser-extension-api-install.
  if (details.png instanceof Uint8Array) {
    const image = nativeImage.createFromBuffer(Buffer.from(details.png))
    return image.isEmpty() ? null : image.toDataURL()
  }
  return extensionIconDataUrl(caller.extension, details.path)
}

handleExtensionApi('action', {
  setTitle: setter('title', (_caller, title) => ({ title: String(title ?? '') })),
  getTitle: getter('title'),
  setPopup: setter('popup', (caller, popup) => ({
    popup: popup ? extensionUrl(caller.extension, popup) : ''
  })),
  getPopup: (caller: ExtensionCaller, details: unknown) => {
    const popup = getter('popup')(caller, details)
    return popup ? extensionUrl(caller.extension, popup) : ''
  },
  setBadgeText: setter('text', (_caller, text) => ({ badgeText: String(text ?? '') })),
  getBadgeText: getter('badgeText'),
  setBadgeBackgroundColor: setter('color', (_caller, color) => ({
    badgeBackgroundColor: parseBadgeColor(color)
  })),
  getBadgeBackgroundColor: (caller: ExtensionCaller, details: unknown) =>
    getter('badgeBackgroundColor')(caller, details) ?? [95, 99, 104, 255],
  setBadgeTextColor: setter('color', (_caller, color) => ({
    badgeTextColor: parseBadgeColor(color)
  })),
  getBadgeTextColor: (caller: ExtensionCaller, details: unknown) =>
    getter('badgeTextColor')(caller, details) ?? [255, 255, 255, 255],
  setIcon: (caller: ExtensionCaller, details: unknown) => {
    const args = objectArg(details)
    const tab = findTab(caller, optionalNumber(args.tabId))
    const iconDataUrl = iconFromDetails(caller, args)
    if (!iconDataUrl) {
      throw new Error('Could not load the action icon')
    }
    writeAction(caller.session, caller.extension, tab, { iconDataUrl })
  },
  enable: (caller: ExtensionCaller, tabId: unknown) =>
    writeAction(caller.session, caller.extension, findTab(caller, optionalNumber(tabId)), {
      enabled: true
    }),
  disable: (caller: ExtensionCaller, tabId: unknown) =>
    writeAction(caller.session, caller.extension, findTab(caller, optionalNumber(tabId)), {
      enabled: false
    }),
  isEnabled: (caller: ExtensionCaller, tabId: unknown) =>
    readAction(caller.session, caller.extension, 'enabled', optionalNumber(tabId)) !== false,
  openPopup: (caller: ExtensionCaller) => {
    const tab = lastExtensionTab()
    if (
      !tab ||
      tab.session !== caller.session ||
      !requestExtensionAction(tab, caller.extension.id)
    ) {
      throw new Error('No active browser tab to open the popup in')
    }
  },
  getUserSettings: () => ({ isOnToolbar: true })
})

/**
 * A toolbar button click: opens the extension's popup under the button, or fires
 * action.onClicked when it has none. `anchor` is in `window`'s content coordinates.
 */
export function activateExtensionAction(
  tab: WebContents,
  extensionId: string,
  anchor: BrowserExtensionActionAnchor,
  window: BrowserWindow
): void {
  const extension = tab.session.extensions.getExtension(extensionId)
  if (!extension || readAction(tab.session, extension, 'enabled', tab.id) === false) {
    return
  }
  const popup = readAction(tab.session, extension, 'popup', tab.id)
  if (!popup) {
    emitExtensionEvent(tab.session, 'action.onClicked', [tabDetails(tab, extension)], extensionId)
    return
  }
  // Why: a second click on the button that opened the popup closes it, as in Chrome. The click
  // blurs the popup first, so a popup of this extension that just closed counts as open.
  const wasOpen =
    openPopup?.webContents.getURL().startsWith(extension.url) ||
    (lastClosed?.extensionId === extensionId && Date.now() - lastClosed.at < TOGGLE_WINDOW_MS)
  openPopup?.close()
  if (!wasOpen) {
    showPopup(tab, extensionId, extensionUrl(extension, popup), anchor, window)
  }
}

function showPopup(
  tab: WebContents,
  extensionId: string,
  url: string,
  anchor: BrowserExtensionActionAnchor,
  window: BrowserWindow
): void {
  const popup = new BrowserWindow({
    parent: window,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    width: POPUP_MIN.width,
    height: POPUP_MIN.height,
    webPreferences: { session: tab.session, enablePreferredSizeMode: true }
  })
  openPopup = popup
  const content = window.getContentBounds()
  const right = content.x + anchor.x + anchor.width
  const top = content.y + anchor.y + anchor.height
  // A popup sizes itself to its page, as Chrome's does, within Chrome's bounds.
  const fit = (size: { width: number; height: number }): void => {
    if (popup.isDestroyed()) {
      return
    }
    const width = Math.min(Math.max(size.width, POPUP_MIN.width), POPUP_MAX.width)
    const height = Math.min(Math.max(size.height, POPUP_MIN.height), POPUP_MAX.height)
    popup.setBounds(placePopup(window, right, top, width, height))
    if (!popup.isVisible() && !isWindowlessLaunch()) {
      popup.show()
    }
  }
  popup.webContents.on('preferred-size-changed', (_event, size) => fit(size))
  // Why measure too: a hidden window may never report a preferred size, and it shows only once sized.
  popup.webContents.once('did-finish-load', () => {
    popup.webContents
      .executeJavaScript(
        '({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })'
      )
      .then((size: { width: number; height: number }) => fit(size))
      .catch(() => fit(POPUP_MAX))
  })
  popup.on('blur', () => popup.close())
  popup.once('closed', () => {
    lastClosed = { extensionId, at: Date.now() }
    if (openPopup === popup) {
      openPopup = null
    }
  })
  void popup.loadURL(url)
}

/**
 * Right-aligns the popup under its button, kept inside Orca's window and the screen's work area
 * so a button near the edge never pushes it off screen.
 */
function placePopup(
  window: BrowserWindow,
  right: number,
  top: number,
  width: number,
  height: number
): Electron.Rectangle {
  const content = window.getContentBounds()
  const area = screen.getDisplayMatching(content).workArea
  const minX = Math.max(content.x, area.x)
  const maxX = Math.min(content.x + content.width, area.x + area.width) - width
  const x = Math.max(minX, Math.min(right - width, maxX))
  const y = Math.min(top, area.y + area.height - height)
  return { x: Math.round(x), y: Math.round(Math.max(area.y, y)), width, height }
}
