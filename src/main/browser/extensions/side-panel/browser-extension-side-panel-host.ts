import { randomUUID } from 'node:crypto'
import {
  BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL,
  type BrowserExtensionSidePanel
} from '../../../../shared/browser/extensions/browser-extension-side-panel-types'
import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { resolveActionIconDataUrl } from '../actions/browser-extension-action-icon'
import {
  iconFromPathSpec,
  readManifestActionDefaults
} from '../actions/browser-extension-action-state'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionSessionForProfile
} from '../profile-sessions/browser-extension-session-loader'
import { browserExtensionSourceProfileId } from '../profile-sessions/browser-extension-route-profiles'
import { getBrowserExtensionMainWindow } from '../tabs-and-windows/browser-extension-window-model'
import { listSidePanelTabsWithOwnOptions } from './browser-extension-side-panel-options'
import { browserExtensionSidePanelWorkspaceForPage } from './browser-extension-side-panel-workspace'

export type BrowserExtensionSidePanelRecord = {
  id: string
  profileId: string
  partition: string
  extensionId: string
  workspaceId: string
  /** The tab a per-tab panel belongs to; null for the workspace-wide (global) panel. */
  tabId: number | null
  path: string
  name: string
  iconDataUrl: string | null
  guest: Electron.WebContents | null
  attachToken: string | null
  opened: boolean
  /** The page the renderer last showed this panel beside; its keys and clicks act for that page. */
  besidePageId: string | null
}

/** Chrome's onOpened/onClosed payload. */
type SidePanelEventInfo = { windowId: number; tabId?: number; path: string }

const panels = new Map<string, BrowserExtensionSidePanelRecord>()

export function browserExtensionSidePanelUrl(panel: BrowserExtensionSidePanelRecord): string {
  return `${getChromeExtensionOrigin(panel.extensionId)}/${panel.path}`
}

function eventInfo(panel: BrowserExtensionSidePanelRecord): SidePanelEventInfo {
  return {
    windowId: getBrowserExtensionMainWindow()?.id ?? -1,
    ...(panel.tabId === null ? {} : { tabId: panel.tabId }),
    // Chrome reports the resource's path ("/panel.html"), without query or fragment.
    path: new URL(panel.path, 'chrome-extension://panel/').pathname
  }
}

function emitPanelEvent(
  panel: BrowserExtensionSidePanelRecord,
  event: 'onOpened' | 'onClosed'
): void {
  const sess = getBrowserExtensionSessionForProfile(panel.profileId)
  if (!sess) {
    return
  }
  emitBrowserExtensionEvent({ session: sess, extensionId: panel.extensionId }, 'sidePanel', event, [
    eventInfo(panel)
  ])
}

function describePanel(panel: BrowserExtensionSidePanelRecord): BrowserExtensionSidePanel {
  const browserPageId =
    panel.tabId === null ? undefined : (browserManager.getTabIdForWebContentsId(panel.tabId) ?? '')
  const hiddenOnPageIds =
    panel.tabId === null
      ? listSidePanelTabsWithOwnOptions(panel.profileId, panel.extensionId).flatMap(
          (tabId) => browserManager.getTabIdForWebContentsId(tabId) ?? []
        )
      : []
  return {
    id: panel.id,
    workspaceId: panel.workspaceId,
    ...(browserPageId === undefined ? {} : { browserPageId }),
    ...(hiddenOnPageIds.length > 0 ? { hiddenOnPageIds } : {}),
    profileId: panel.profileId,
    browserProfileId: browserExtensionSourceProfileId(panel.profileId),
    partition: panel.partition,
    extensionId: panel.extensionId,
    name: panel.name,
    iconDataUrl: panel.iconDataUrl
  }
}

export function listBrowserExtensionSidePanels(): BrowserExtensionSidePanel[] {
  return [...panels.values()].map(describePanel)
}

let publishQueued = false

/** One push per task: an open that replaces another panel changes the list twice. */
export function publishBrowserExtensionSidePanels(): void {
  if (publishQueued) {
    return
  }
  publishQueued = true
  queueMicrotask(() => {
    publishQueued = false
    const mainWindow = getBrowserExtensionMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL,
        listBrowserExtensionSidePanels()
      )
    }
  })
}

export function closeBrowserExtensionSidePanel(panel: BrowserExtensionSidePanelRecord): void {
  if (panels.get(panel.id) !== panel) {
    return
  }
  panels.delete(panel.id)
  panel.attachToken = null
  if (panel.opened) {
    emitPanelEvent(panel, 'onClosed')
  }
  publishBrowserExtensionSidePanels()
}

function findPanel(
  profileId: string,
  extensionId: string,
  workspaceId: string,
  tabId: number | null
): BrowserExtensionSidePanelRecord | null {
  for (const panel of panels.values()) {
    if (
      panel.profileId === profileId &&
      panel.extensionId === extensionId &&
      panel.workspaceId === workspaceId &&
      panel.tabId === tabId
    ) {
      return panel
    }
  }
  return null
}

async function resolvePanelIcon(extension: Electron.Extension): Promise<string | null> {
  const defaults = readManifestActionDefaults(extension.manifest, extension.name)
  return resolveActionIconDataUrl(
    extension.path,
    iconFromPathSpec(extension.manifest?.icons) ?? defaults.icon
  ).catch(() => null)
}

/**
 * Shows the extension's panel in a workspace: its global panel, or (with `tabId`) the panel for
 * that tab. Like Chrome, a workspace shows one global panel and a tab one panel of its own, so
 * opening another extension's replaces it; reopening with a new page navigates in place.
 * `fromTabId` is the tab the open came from: a global panel opened there replaces whatever that
 * tab showed, as Chrome's one panel area does.
 */
export function openBrowserExtensionSidePanel(args: {
  profileId: string
  extension: Electron.Extension
  workspaceId: string
  tabId: number | null
  /** Null for a window-level open, which never replaces a tab's own panel. */
  fromTabId: number | null
  path: string
}): void {
  const { profileId, extension, workspaceId, tabId, fromTabId, path } = args
  for (const panel of panels.values()) {
    const sameExtension = panel.profileId === profileId && panel.extensionId === extension.id
    // Only another extension's panel is replaced: the extension's own tab panel outranks its global one.
    const replaced =
      !sameExtension &&
      panel.workspaceId === workspaceId &&
      (panel.tabId === tabId || (tabId === null && panel.tabId === fromTabId))
    if (replaced) {
      closeBrowserExtensionSidePanel(panel)
    }
  }
  const existing = findPanel(profileId, extension.id, workspaceId, tabId)
  if (existing) {
    navigateBrowserExtensionSidePanel(existing, path)
    return
  }
  const profile = getBrowserExtensionProfile(profileId)
  if (!profile) {
    return
  }
  const panel: BrowserExtensionSidePanelRecord = {
    id: randomUUID(),
    profileId,
    partition: profile.partition,
    extensionId: extension.id,
    workspaceId,
    tabId,
    path,
    name: getBrowserExtensionInstallStore().get(extension.id)?.name ?? extension.name,
    iconDataUrl: null,
    guest: null,
    attachToken: null,
    opened: false,
    besidePageId: null
  }
  panels.set(panel.id, panel)
  publishBrowserExtensionSidePanels()
  void resolvePanelIcon(extension).then((iconDataUrl) => {
    if (panels.get(panel.id) === panel && iconDataUrl) {
      panel.iconDataUrl = iconDataUrl
      publishBrowserExtensionSidePanels()
    }
  })
}

function navigateBrowserExtensionSidePanel(
  panel: BrowserExtensionSidePanelRecord,
  path: string
): void {
  if (panel.path === path) {
    return
  }
  panel.path = path
  const guest = panel.guest
  if (guest && !guest.isDestroyed()) {
    guest.loadURL(browserExtensionSidePanelUrl(panel)).catch(() => {})
  }
}

/** The panels of one extension in a profile, optionally only those of one tab or the global ones. */
export function findBrowserExtensionSidePanels(
  profileId: string,
  extensionId: string,
  scope?: { tabId: number | null }
): BrowserExtensionSidePanelRecord[] {
  return [...panels.values()].filter(
    (panel) =>
      panel.profileId === profileId &&
      panel.extensionId === extensionId &&
      (scope === undefined || panel.tabId === scope.tabId)
  )
}

/**
 * The panel a tab shows, whichever extension it belongs to: a panel opened for that tab, else the
 * workspace's global one unless its extension set options for the tab (the renderer's rule too).
 */
export function findShownBrowserExtensionSidePanel(
  workspaceId: string,
  tabId: number
): BrowserExtensionSidePanelRecord | null {
  const inWorkspace = [...panels.values()].filter((panel) => panel.workspaceId === workspaceId)
  const global = inWorkspace.find((panel) => panel.tabId === null)
  return (
    inWorkspace.find((panel) => panel.tabId === tabId) ??
    (global &&
    !listSidePanelTabsWithOwnOptions(global.profileId, global.extensionId).includes(tabId)
      ? global
      : null)
  )
}

export function closeBrowserExtensionSidePanels(
  list: readonly BrowserExtensionSidePanelRecord[]
): void {
  for (const panel of list) {
    closeBrowserExtensionSidePanel(panel)
  }
}

export function getBrowserExtensionSidePanelRecord(
  panelId: string
): BrowserExtensionSidePanelRecord | null {
  return panels.get(panelId) ?? null
}

export function findBrowserExtensionSidePanelByAttachToken(
  token: string
): BrowserExtensionSidePanelRecord | null {
  return [...panels.values()].find((panel) => panel.attachToken === token) ?? null
}

/** Chrome fires onOpened once per open, after the panel's document first loads. */
export function markBrowserExtensionSidePanelOpened(panel: BrowserExtensionSidePanelRecord): void {
  if (panels.get(panel.id) === panel && !panel.opened) {
    panel.opened = true
    emitPanelEvent(panel, 'onOpened')
  }
}

/** Options changed: a disabled scope closes, a new page navigates in place. */
export function applyBrowserExtensionSidePanelOptions(
  profileId: string,
  extensionId: string,
  tabId: number | null,
  options: { path?: string; enabled: boolean }
): void {
  for (const panel of findBrowserExtensionSidePanels(profileId, extensionId, { tabId })) {
    if (!options.enabled || !options.path) {
      closeBrowserExtensionSidePanel(panel)
    } else {
      navigateBrowserExtensionSidePanel(panel, options.path)
    }
  }
  // Why republish for tab options: an open global panel steps aside on tabs that have their own.
  // Only then: some extensions set tab options on every tabs.onUpdated.
  if (
    tabId !== null &&
    findBrowserExtensionSidePanels(profileId, extensionId, { tabId: null }).length
  ) {
    publishBrowserExtensionSidePanels()
  }
}

/** The renderer showed the panel beside this page of its workspace. */
export function noteBrowserExtensionSidePanelShown(panelId: string, browserPageId: string): void {
  const panel = panels.get(panelId)
  if (panel && browserExtensionSidePanelWorkspaceForPage(browserPageId) === panel.workspaceId) {
    panel.besidePageId = browserPageId
  }
}

export function closeBrowserExtensionSidePanelById(panelId: string): void {
  const panel = panels.get(panelId)
  if (panel) {
    closeBrowserExtensionSidePanel(panel)
  }
}

export function closeBrowserExtensionSidePanelsForTab(tabId: number): void {
  for (const panel of panels.values()) {
    if (panel.tabId === tabId) {
      closeBrowserExtensionSidePanel(panel)
    }
  }
}

export function closeBrowserExtensionSidePanelsForExtension(
  profileId: string,
  extensionId: string
): void {
  closeBrowserExtensionSidePanels(findBrowserExtensionSidePanels(profileId, extensionId))
}
