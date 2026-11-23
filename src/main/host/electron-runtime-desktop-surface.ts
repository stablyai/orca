import { BrowserWindow, Notification, powerMonitor, powerSaveBlocker, webContents } from 'electron'
import { isResourceWindowVisible } from '../window/visibility/resource-view-admission'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import { showDesktopNotification } from '../notifications/desktop-notification'
import type { RuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { electronRendererWindows } from './electron-renderer-windows'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'
import { electronBrowserTabFaviconFetch } from './electron-browser-tab-favicon-fetch'

export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  translateNotification: translateMain,
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body }) => {
    if (!Notification.isSupported()) {
      return false
    }
    showDesktopNotification(new Notification({ title, body }))
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
  holdDisplayAwake: () => {
    const id = powerSaveBlocker.start('prevent-display-sleep')
    return () => {
      if (powerSaveBlocker.isStarted(id)) {
        powerSaveBlocker.stop(id)
      }
    }
  },
  isResourceViewVisible: (rendererId) => {
    const renderer = webContents.fromId(rendererId)
    return isResourceWindowVisible(renderer ? BrowserWindow.fromWebContents(renderer) : null)
  },
  // Phone icons (repo icons, browser tab favicons) are fetched and shrunk to data URLs here.
  encodeRepoIconPng,
  fetchRepoIcon: (url, init) => fetchWithElectronManualRedirects(url, init),
  browserTabFaviconFetch: electronBrowserTabFaviconFetch
}
