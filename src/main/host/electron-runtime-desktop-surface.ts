import { BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { RuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { createNotificationRevealHandler } from '../ipc/notification-reveal-target'

/** The desktop implementation of the runtime's optional desktop facilities. */
export const electronRuntimeDesktopSurface: RuntimeDesktopSurface = {
  isAwayForMobileNotifications: () => readDesktopAwayState(powerMonitor),
  showNotification: ({ title, body, target }) => {
    if (!Notification.isSupported()) {
      return false
    }
    const notification = new Notification({ title, body })
    const reveal = target ? createNotificationRevealHandler(target) : null
    if (reveal) {
      // Why: keep the notification and its click handler alive until it is clicked or dismissed.
      const onClick = (): void => {
        release()
        reveal()
      }
      const release = retainNotificationUntilRelease(notification, () =>
        notification.removeListener('click', onClick)
      )
      notification.on('click', onClick)
    }
    notification.show()
    return true
  },
  findWindowById: (id) => BrowserWindow.fromId(id),
  onIpc: (channel, listener) => {
    ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1])
  },
  removeIpcListener: (channel, listener) => {
    ipcMain.removeListener(channel, listener as Parameters<typeof ipcMain.removeListener>[1])
  }
}
