import { BrowserWindow, Notification, powerMonitor, webContents } from 'electron'
import { isResourceWindowVisible } from '../window/visibility/resource-view-admission'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { RuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { electronRendererWindows } from './electron-renderer-windows'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-list/feed/sidebar-inputs-switch'

export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  translateNotification: translateMain,
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body }) => {
    if (!Notification.isSupported()) {
      return false
    }
    new Notification({ title, body }).show()
    return true
  },
  sendToRenderers: (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      try {
        window.webContents.send(channel, payload)
      } catch {
        // A renderer can disappear between isDestroyed() and send().
      }
    }
  },
  ...electronRendererWindows,
  isResourceViewVisible: (rendererId) => {
    const renderer = webContents.fromId(rendererId)
    return isResourceWindowVisible(renderer ? BrowserWindow.fromWebContents(renderer) : null)
  },
  // Only the phone icon source needs these codecs and fetcher.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? { encodeRepoIconPng, fetchRepoIcon: fetchWithElectronManualRedirects }
    : {})
}
