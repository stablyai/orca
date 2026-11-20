import { isResourceWindowVisible } from '../window/visibility/resource-view-admission'
import { BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import { showDesktopNotification } from '../notifications/desktop-notification'
import type { RuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

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
  findWindowById: (id) => BrowserWindow.fromId(id),
  isResourceViewVisible: (sender) => isResourceWindowVisible(BrowserWindow.fromWebContents(sender)),
  onIpc: (channel, listener) => {
    ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1])
  },
  removeIpcListener: (channel, listener) => {
    ipcMain.removeListener(channel, listener as Parameters<typeof ipcMain.removeListener>[1])
  },
  // Phone icons (repo icons, browser tab favicons) are fetched and shrunk to data URLs here.
  encodeRepoIconPng,
  fetchRepoIcon: fetchWithElectronManualRedirects
}
