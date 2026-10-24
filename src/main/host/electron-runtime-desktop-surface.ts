import { isResourceWindowVisible } from '../window/resource-view-admission'
import { BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { RuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { translateMain } from '../i18n/main-i18n'
import { encodeRepoIconPng } from './electron-repo-icon-png'
import { fetchRepoIconWithManualRedirects } from './electron-repo-icon-fetch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { preferredDesktopRenderer } from '../window/desktop-renderer-registry'
import { NATIVE_DESKTOP_GRAPH_ID } from '../runtime/native-desktop-window-graphs'

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
  findWindowById: (id) => {
    if (id !== NATIVE_DESKTOP_GRAPH_ID) {
      return BrowserWindow.fromId(id)
    }
    const renderer = preferredDesktopRenderer()
    return renderer ? BrowserWindow.fromWebContents(renderer) : null
  },
  isResourceViewVisible: (sender) => isResourceWindowVisible(BrowserWindow.fromWebContents(sender)),
  onIpc: (channel, listener) => {
    ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1])
  },
  removeIpcListener: (channel, listener) => {
    ipcMain.removeListener(channel, listener as Parameters<typeof ipcMain.removeListener>[1])
  },
  // Only the phone icon source needs these codecs and fetcher.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? { encodeRepoIconPng, fetchRepoIcon: fetchRepoIconWithManualRedirects }
    : {})
}
