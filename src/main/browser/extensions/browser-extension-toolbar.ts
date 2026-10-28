import { webContents } from 'electron'
import { noteBrowserExtensionUserGesture } from './api/permissions'
import type { BrowserExtensionActionResult } from '../../../shared/browser-extension-types'
import {
  BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL,
  BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL,
  type BrowserExtensionAnchorRect,
  type BrowserExtensionPopupRequest,
  type BrowserExtensionToolbarAction,
  type BrowserExtensionToolbarState
} from '../../../shared/browser-extension-toolbar-types'
import { browserManager } from '../browser-manager'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from './browser-extension-api-host'
import { resolveActionIconDataUrl } from './browser-extension-action-icon'
import { grantBrowserExtensionActiveTab } from './browser-extension-active-tab'
import {
  getBrowserExtensionActionState,
  observeBrowserExtensionActionSession,
  onBrowserExtensionActionsChanged
} from './browser-extension-action-registry'
import {
  browserExtensionColorToCss,
  iconFromPathSpec,
  readManifestActionDefaults
} from './browser-extension-action-state'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { BrowserExtensionApiError } from './browser-extension-namespace-registry'
import {
  consumeBrowserExtensionPopupToggle,
  getOpenBrowserExtensionPopup,
  openBrowserExtensionPopup
} from './browser-extension-popup-host'
import {
  describeBrowserExtensionTab,
  getActiveBrowserTabId,
  openBrowserExtensionTab,
  recordActiveBrowserPage,
  resolveBrowserExtensionTab
} from './browser-extension-tab-model'
import { getPinnedBrowserExtensionIds } from './browser-extension-toolbar-pins'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'
import {
  parseChromeExtensionUrl,
  resolveBrowserExtensionRequestedUrl
} from '../../../shared/browser-extension-url'

const TOOLBAR_CHANGED_DELAY_MS = 50
const POPUP_REQUEST_TIMEOUT_MS = 3_000

type ToolbarPage = {
  contents: Electron.WebContents
  session: Electron.Session
  profileId: string
}

function liveContents(id: number | null): Electron.WebContents | null {
  const contents = id === null ? undefined : webContents.fromId(id)
  return contents && !contents.isDestroyed() ? contents : null
}

/** A browser page whose session runs extensions (a local browser profile), else null. */
function resolveToolbarPage(browserPageId: string): ToolbarPage | null {
  const contents = liveContents(browserManager.getGuestWebContentsId(browserPageId))
  const profileId = contents ? getBrowserExtensionProfileIdForSession(contents.session) : null
  return contents && profileId ? { contents, session: contents.session, profileId } : null
}

function manifestHasOptionsPage(extension: Electron.Extension): boolean {
  const manifest: { options_ui?: { page?: unknown }; options_page?: unknown } =
    extension.manifest ?? {}
  return typeof (manifest.options_ui?.page ?? manifest.options_page) === 'string'
}

async function describeToolbarAction(
  page: ToolbarPage,
  extension: Electron.Extension,
  pinned: ReadonlySet<string>
): Promise<BrowserExtensionToolbarAction> {
  const installed = getBrowserExtensionInstallStore().get(extension.id)
  const details = getBrowserExtensionActionState(page.profileId, extension).get(page.contents.id)
  return {
    extensionId: extension.id,
    name: installed?.name ?? extension.name,
    title: details.title,
    iconDataUrl: await resolveActionIconDataUrl(extension.path, details.icon),
    badgeText: details.badgeText,
    badgeBackgroundColor: browserExtensionColorToCss(details.badgeBackgroundColor),
    badgeTextColor: browserExtensionColorToCss(details.badgeTextColor),
    enabled: details.enabled,
    hasPopup: details.popup !== '',
    pinned: pinned.has(extension.id),
    hasOptionsPage: manifestHasOptionsPage(extension),
    source: installed?.source ?? 'unpacked'
  }
}

/** Every enabled extension's button for one page, pinned ones first in pin order. */
export async function getBrowserExtensionToolbarState(
  browserPageId: string
): Promise<BrowserExtensionToolbarState | null> {
  const page = resolveToolbarPage(browserPageId)
  if (!page) {
    return null
  }
  observeBrowserExtensionActionSession(page.session)
  const pinOrder = getPinnedBrowserExtensionIds(page.profileId)
  const pinned = new Set(pinOrder)
  const actions = await Promise.all(
    page.session.extensions
      .getAllExtensions()
      .map((extension) => describeToolbarAction(page, extension, pinned))
  )
  const rank = (action: BrowserExtensionToolbarAction): number =>
    action.pinned ? pinOrder.indexOf(action.extensionId) : Number.MAX_SAFE_INTEGER
  actions.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return { profileId: page.profileId, actions }
}

function openPopupForPage(
  page: ToolbarPage,
  extension: Electron.Extension,
  popupPath: string,
  anchor: BrowserExtensionAnchorRect
): void {
  openBrowserExtensionPopup({
    session: page.session,
    profileId: page.profileId,
    extensionId: extension.id,
    popupPath,
    anchor,
    openTab: (rawUrl) => {
      const resolved = resolveBrowserExtensionRequestedUrl(rawUrl, extension.id)
      if (resolved && (resolved.kind !== 'extension' || resolved.extensionId === extension.id)) {
        void openBrowserExtensionTab(page.profileId, resolved.url, true).catch(() => {})
      }
    }
  })
  resolvePendingPopupRequest(page.profileId, extension.id)
}

/** An action event goes to whichever name the extension listens on: action (MV3) or browserAction. */
export function emitBrowserExtensionActionEvent(
  sess: Electron.Session,
  extensionId: string,
  event: string,
  args: unknown[]
): void {
  for (const namespace of ['action', 'browserAction']) {
    emitBrowserExtensionEvent({ session: sess, extensionId }, namespace, event, args)
  }
}

function emitActionClicked(
  sess: Electron.Session,
  extension: Electron.Extension,
  tabId: number
): void {
  const entry = resolveBrowserExtensionTab(tabId)
  const tab = entry ? describeBrowserExtensionTab(extension, entry) : undefined
  emitBrowserExtensionActionEvent(sess, extension.id, 'onClicked', tab ? [tab] : [])
}

/**
 * A toolbar click: show the popup (a second click closes it) or, with no popup, fire
 * action.onClicked with the page's tab. `popupOnly` is the answer to action.openPopup.
 */
export function activateBrowserExtensionAction(args: {
  browserPageId: string
  extensionId: string
  anchor: BrowserExtensionAnchorRect
  popupOnly: boolean
}): BrowserExtensionActionResult {
  try {
    const page = resolveToolbarPage(args.browserPageId)
    const extension = page?.session.extensions.getExtension(args.extensionId)
    if (!page || !extension) {
      throw new BrowserExtensionApiError('This extension is not on for this tab')
    }
    // Why: the clicked toolbar belongs to the page the user is on, even if no tab switch told
    // main yet (a tab restored at launch); the popup's tabs.query({active}) must find it.
    recordActiveBrowserPage(args.browserPageId)
    const details = getBrowserExtensionActionState(page.profileId, extension).get(page.contents.id)
    if (!args.popupOnly && consumeBrowserExtensionPopupToggle(page.profileId, extension.id)) {
      return { ok: true }
    }
    if (!details.enabled && !args.popupOnly) {
      return { ok: true }
    }
    if (!args.popupOnly) {
      noteBrowserExtensionUserGesture(page.session, extension.id)
      grantBrowserExtensionActiveTab(extension, page.contents.id)
    }
    if (details.popup !== '') {
      openPopupForPage(page, extension, details.popup, args.anchor)
      return { ok: true }
    }
    if (args.popupOnly) {
      throw new BrowserExtensionApiError('This extension has no popup')
    }
    emitActionClicked(page.session, extension, page.contents.id)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const pendingPopupRequests = new Map<string, Set<(error?: Error) => void>>()

function popupRequestKey(profileId: string, extensionId: string): string {
  return `${profileId}\0${extensionId}`
}

function resolvePendingPopupRequest(profileId: string, extensionId: string): void {
  const key = popupRequestKey(profileId, extensionId)
  const pending = pendingPopupRequests.get(key)
  pendingPopupRequests.delete(key)
  for (const settle of pending ?? []) {
    settle()
  }
}

/**
 * action.openPopup and the _execute_action command: the renderer knows where the button is, so
 * main asks the toolbar of `tabId`'s page (by default the active one) to open the popup there.
 */
export function requestBrowserExtensionPopup(
  sess: Electron.Session,
  extensionId: string,
  tabId = getActiveBrowserTabId()
): Promise<void> {
  const profileId = getBrowserExtensionProfileIdForSession(sess)
  const tab = liveContents(tabId)
  if (!profileId || !tab || tab.session !== sess) {
    return Promise.reject(new BrowserExtensionApiError('No active tab to show the popup on'))
  }
  const browserPageId = browserManager.getTabIdForWebContentsId(tab.id)
  const mainWindow = getBrowserExtensionMainWindow()
  // Why: only Orca's own tabs have a toolbar; a popout, like Chrome's popup windows, has none.
  if (!browserPageId || !mainWindow) {
    return Promise.reject(new BrowserExtensionApiError('This window has no toolbar for the popup'))
  }
  const open = getOpenBrowserExtensionPopup()
  if (open?.profileId === profileId && open.extensionId === extensionId) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const key = popupRequestKey(profileId, extensionId)
    const settle = (error?: Error): void => {
      clearTimeout(timer)
      pendingPopupRequests.get(key)?.delete(settle)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(
      () => settle(new BrowserExtensionApiError('Could not show the popup')),
      POPUP_REQUEST_TIMEOUT_MS
    )
    const pending = pendingPopupRequests.get(key) ?? new Set()
    pending.add(settle)
    pendingPopupRequests.set(key, pending)
    const request: BrowserExtensionPopupRequest = { browserPageId, extensionId }
    mainWindow.webContents.send(BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL, request)
  })
}

/**
 * The tab a shortcut pressed in `contents` acts on: that tab, else (an action popup) the active
 * page's, and only if it is in the same profile; the active page may be another profile's.
 */
function shortcutTabId(contents: Electron.WebContents): number | null {
  const tab = liveContents(
    resolveBrowserExtensionTab(contents.id)?.contents.id ?? getActiveBrowserTabId()
  )
  return tab && tab.session === contents.session ? tab.id : null
}

/** _execute_action: what clicking the extension's toolbar button does, from a keyboard command. */
export async function runBrowserExtensionToolbarAction(
  contents: Electron.WebContents,
  extension: Electron.Extension
): Promise<void> {
  const sess = contents.session
  const profileId = getBrowserExtensionProfileIdForSession(sess)
  const tabId = shortcutTabId(contents)
  if (!profileId || tabId === null) {
    return
  }
  const details = getBrowserExtensionActionState(profileId, extension).get(tabId)
  if (!details.enabled) {
    return
  }
  grantBrowserExtensionActiveTab(extension, tabId)
  if (details.popup !== '') {
    await requestBrowserExtensionPopup(sess, extension.id, tabId)
    return
  }
  emitActionClicked(sess, extension, tabId)
}

const changedProfiles = new Set<string>()
let changedTimer: NodeJS.Timeout | null = null

/** Coalesces action changes (badges change per request on some extensions) into one repaint. */
export function installBrowserExtensionToolbarNotifications(): void {
  onBrowserExtensionActionsChanged((profileId) => {
    changedProfiles.add(profileId)
    changedTimer ??= setTimeout(() => {
      changedTimer = null
      const mainWindow = getBrowserExtensionMainWindow()
      for (const changed of changedProfiles) {
        mainWindow?.webContents.send(BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL, {
          profileId: changed
        })
      }
      changedProfiles.clear()
    }, TOOLBAR_CHANGED_DELAY_MS)
  })
}

/** The favicon for a tab showing an extension page: that extension's icon, as a data URL. */
export async function getBrowserExtensionPageIcon(browserPageId: string): Promise<string | null> {
  const contents = liveContents(browserManager.getGuestWebContentsId(browserPageId))
  const parsed = contents ? parseChromeExtensionUrl(contents.getURL()) : null
  const extension = parsed ? contents?.session.extensions.getExtension(parsed.extensionId) : null
  if (!extension) {
    return null
  }
  const defaults = readManifestActionDefaults(extension.manifest, extension.name)
  return resolveActionIconDataUrl(
    extension.path,
    iconFromPathSpec(extension.manifest?.icons) ?? defaults.icon
  )
}
