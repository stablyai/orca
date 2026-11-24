import { BrowserWindow, Notification, powerMonitor, webContents } from 'electron'
import { isResourceWindowVisible } from '../window/visibility/resource-view-admission'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import { showDesktopNotification } from '../notifications/desktop-notification'
import { retainNotificationUntilRelease } from '../ipc/notifications/native-notification-lifecycle'
import type { RuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { electronRendererWindows } from './electron-renderer-windows'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'
import { electronBrowserTabFaviconFetch } from './electron-browser-tab-favicon-fetch'
import { holdPowerSaveBlocker } from '../power/power-save-blocker-hold'

export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  translateNotification: translateMain,
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body, onClick }) => {
    if (!Notification.isSupported()) {
      return false
    }
    const notification = new Notification({ title, body })
    if (onClick) {
      // Retained so the click still reaches the handler after garbage collection would run.
      const release = retainNotificationUntilRelease(notification)
      notification.once('click', () => {
        release()
        onClick()
      })
    }
    showDesktopNotification(notification)
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
  holdDisplayAwake: () => holdPowerSaveBlocker('prevent-display-sleep'),
  readScreenState: () => {
    // The shortest display-sleep setting is a minute, so a shorter idle can't mean a sleeping display.
    const state = powerMonitor.getSystemIdleState(60)
    return state === 'locked' || state === 'idle' ? state : 'active'
  },
  onScreenLocked: (listener) => {
    powerMonitor.on('lock-screen', listener)
    return () => powerMonitor.off('lock-screen', listener)
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
