import { isResourceWindowVisible } from '../window/visibility/resource-view-admission'
import { BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import {
  closeDesktopNotification,
  showDesktopNotification
} from '../notifications/desktop-notification'
import type { RuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchWithElectronManualRedirects } from './electron-manual-redirect-fetch'

const mailboxAnnouncements = new Map<string, Notification>()

export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  translateNotification: translateMain,
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body, notificationId }) => {
    if (!Notification.isSupported()) {
      return false
    }
    const notification = new Notification({ title, body })
    if (notificationId) {
      const previous = mailboxAnnouncements.get(notificationId)
      if (previous) {
        closeDesktopNotification(previous)
      }
      mailboxAnnouncements.set(notificationId, notification)
      const forget = () => {
        if (mailboxAnnouncements.get(notificationId) === notification) {
          mailboxAnnouncements.delete(notificationId)
        }
      }
      notification.once('close', forget)
      notification.once('failed', forget)
    }
    showDesktopNotification(notification)
    return true
  },
  dismissNotification: (id) => {
    const notification = mailboxAnnouncements.get(id)
    mailboxAnnouncements.delete(id)
    if (notification) {
      closeDesktopNotification(notification)
    }
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
