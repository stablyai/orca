import { BrowserWindow, ipcMain, Notification, powerMonitor, webContents } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { RuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'

/** The desktop implementation of the runtime's optional desktop facilities. */
export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body }) => {
    if (!Notification.isSupported()) {
      return false
    }
    new Notification({ title, body }).show()
    return true
  },
  findWindowById: (id) => BrowserWindow.fromId(id),
  onIpc: (channel, listener) => {
    ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1])
  },
  removeIpcListener: (channel, listener) => {
    ipcMain.removeListener(channel, listener as Parameters<typeof ipcMain.removeListener>[1])
  },
  getWebContentsOSProcessId: (webContentsId: number): number | null => {
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) {
      return null
    }
    const pid = wc.getOSProcessId()
    return typeof pid === 'number' && pid > 0 ? pid : null
  }
}
