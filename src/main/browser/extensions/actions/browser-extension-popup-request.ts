import { webContents } from 'electron'
import {
  BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL,
  type BrowserExtensionPopupRequest
} from '../../../../shared/browser/extensions/browser-extension-toolbar-types'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'
import { getBrowserExtensionMainWindow } from '../tabs-and-windows/browser-extension-window-model'
import { getOpenBrowserExtensionPopup } from './browser-extension-popup-host'

const POPUP_REQUEST_TIMEOUT_MS = 3_000

function liveContents(id: number | null): Electron.WebContents | null {
  const contents = id === null ? undefined : webContents.fromId(id)
  return contents && !contents.isDestroyed() ? contents : null
}

const pendingPopupRequests = new Map<string, Set<(error?: Error) => void>>()

function popupRequestKey(profileId: string, extensionId: string): string {
  return `${profileId}\0${extensionId}`
}

/** The popup opened; every action.openPopup waiting on it resolves. */
export function resolvePendingPopupRequest(profileId: string, extensionId: string): void {
  const key = popupRequestKey(profileId, extensionId)
  const pending = pendingPopupRequests.get(key)
  pendingPopupRequests.delete(key)
  for (const settle of pending ?? []) {
    settle()
  }
}

/**
 * action.openPopup and the _execute_action command: the renderer knows where the button is, so
 * main asks the toolbar of `tabId`'s page to open the popup there.
 */
export function requestBrowserExtensionPopup(
  sess: Electron.Session,
  extensionId: string,
  tabId: number | null
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
