import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { getBrowserExtensionSessionForProfile } from '../profile-sessions/browser-extension-session-loader'
import {
  BrowserExtensionApiError,
  extensionHasPermission
} from '../api-runtime/browser-extension-namespace-registry'
import {
  applyBrowserExtensionSidePanelOptions,
  closeBrowserExtensionSidePanels,
  findShownBrowserExtensionSidePanel,
  openBrowserExtensionSidePanel
} from './browser-extension-side-panel-host'
import {
  getOpenSidePanelOnActionClick,
  getSidePanelGlobalOptions,
  getSidePanelTabOptions,
  isUsableSidePanel,
  setSidePanelOptions
} from './browser-extension-side-panel-options'

/** The browser workspace a main-window tab sits in; popouts and unregistered pages have none. */
export function resolveSidePanelWorkspace(tabId: number): string | null {
  const browserPageId = browserManager.getTabIdForWebContentsId(tabId)
  return browserPageId ? browserManager.getWorkspaceIdForPage(browserPageId) : null
}

/**
 * Opens what the extension shows on this tab: the tab's own panel when it has options, else the
 * global panel in the tab's workspace. `errorScope` names the target in Chrome's error text.
 */
export function openBrowserExtensionSidePanelOnTab(
  profileId: string,
  extension: Electron.Extension,
  tabId: number,
  errorScope: string
): void {
  const workspaceId = resolveSidePanelWorkspace(tabId)
  if (!workspaceId) {
    throw new BrowserExtensionApiError(`No side panel in this window for ${errorScope}`)
  }
  const tabOptions = getSidePanelTabOptions(profileId, extension.id, tabId)
  const target = tabOptions ?? getSidePanelGlobalOptions(profileId, extension)
  if (!isUsableSidePanel(target)) {
    throw new BrowserExtensionApiError(`No active side panel for ${errorScope}`)
  }
  openBrowserExtensionSidePanel({
    profileId,
    extension,
    workspaceId,
    tabId: tabOptions ? tabId : null,
    fromTabId: tabId,
    path: target.path
  })
}

/**
 * sidePanel.open({windowId}), as Chrome's OpenGlobalExtensionSidePanel: the global options must
 * be usable. A panel the active tab shows of its own stays, and the global one waits for other
 * tabs; otherwise Chrome's Show prefers the extension's own entry for the tab over its global one.
 */
export function openBrowserExtensionSidePanelForWindow(
  profileId: string,
  extension: Electron.Extension,
  activeTabId: number,
  errorScope: string
): void {
  const workspaceId = resolveSidePanelWorkspace(activeTabId)
  const globalOptions = getSidePanelGlobalOptions(profileId, extension)
  if (!workspaceId || !isUsableSidePanel(globalOptions)) {
    throw new BrowserExtensionApiError(`No active side panel for ${errorScope}`)
  }
  const tabPanelShown = findShownBrowserExtensionSidePanel(workspaceId, activeTabId)?.tabId
  const tabOptions = getSidePanelTabOptions(profileId, extension.id, activeTabId)
  if (tabPanelShown !== activeTabId && isUsableSidePanel(tabOptions)) {
    openBrowserExtensionSidePanel({
      profileId,
      extension,
      workspaceId,
      tabId: activeTabId,
      fromTabId: activeTabId,
      path: tabOptions.path
    })
    return
  }
  openBrowserExtensionSidePanel({
    profileId,
    extension,
    workspaceId,
    tabId: null,
    fromTabId: null,
    path: globalOptions.path
  })
}

/** Shows or hides the panel the tab would show; false when the tab has no usable panel. */
function toggleBrowserExtensionSidePanelOnTab(
  profileId: string,
  extension: Electron.Extension,
  tabId: number
): boolean {
  const workspaceId = resolveSidePanelWorkspace(tabId)
  const options =
    getSidePanelTabOptions(profileId, extension.id, tabId) ??
    getSidePanelGlobalOptions(profileId, extension)
  if (!workspaceId || !isUsableSidePanel(options)) {
    return false
  }
  const shown = findShownBrowserExtensionSidePanel(workspaceId, tabId)
  // Why only its own: clicking another extension's button replaces the shown panel instead.
  if (shown?.profileId === profileId && shown.extensionId === extension.id) {
    closeBrowserExtensionSidePanels([shown])
  } else {
    openBrowserExtensionSidePanelOnTab(profileId, extension, tabId, `tabId: ${tabId}`)
  }
  return true
}

/**
 * setPanelBehavior({openPanelOnActionClick}): a toolbar click or _execute_action toggles the tab's
 * panel instead of the popup or onClicked, and (as in Chrome) grants no activeTab. False leaves
 * the click as usual.
 */
export function toggleBrowserExtensionSidePanelFromAction(
  profileId: string,
  extension: Electron.Extension,
  tabId: number
): boolean {
  return (
    // Why the session: an optional sidePanel permission counts once the user granted it.
    extensionHasPermission(
      extension,
      'sidePanel',
      getBrowserExtensionSessionForProfile(profileId) ?? undefined
    ) &&
    getOpenSidePanelOnActionClick(profileId, extension.id) &&
    toggleBrowserExtensionSidePanelOnTab(profileId, extension, tabId)
  )
}

/**
 * sidePanel.setOptions: stores the change, closes or navigates what it affects, and when a tab
 * gets a page of its own while showing this extension's global panel, swaps to the tab's panel
 * (Chrome replaces the shown entry instead of leaving the tab without one).
 */
export function changeBrowserExtensionSidePanelOptions(
  profileId: string,
  extension: Electron.Extension,
  change: { tabId?: number; path?: string; enabled?: boolean }
): void {
  const tabId = change.tabId ?? null
  const workspaceId = tabId === null ? null : resolveSidePanelWorkspace(tabId)
  const shownBefore =
    workspaceId && tabId !== null ? findShownBrowserExtensionSidePanel(workspaceId, tabId) : null
  const next = setSidePanelOptions(profileId, extension, change)
  applyBrowserExtensionSidePanelOptions(profileId, extension.id, tabId, next)
  if (
    workspaceId &&
    tabId !== null &&
    shownBefore?.tabId === null &&
    shownBefore.profileId === profileId &&
    shownBefore.extensionId === extension.id &&
    isUsableSidePanel(next)
  ) {
    openBrowserExtensionSidePanel({
      profileId,
      extension,
      workspaceId,
      tabId,
      fromTabId: tabId,
      path: next.path
    })
  }
}
