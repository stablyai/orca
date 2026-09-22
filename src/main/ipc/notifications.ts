import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { Store } from '../persistence'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult
} from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readNotificationAuthorizationStatus } from './notification-authorization-status'
import { setTrayAttention } from '../tray/system-tray'
import { isMainWindowVisible } from '../window/main-window-visibility'
import { activeNotificationsById } from './native-notification-lifecycle'
import { deliverNativeNotification } from './native-notification-delivery'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import { registerNotificationSoundHandlers } from './notification-sound-ipc'
import { openNotificationSystemSettings } from './notification-system-settings-link'
import {
  getLastObservedDeliveryOutcome,
  hasTriggeredPermissionDialogThisSession,
  probeNotificationDelivery,
  recordNotificationDeliveryOutcome,
  resetNotificationPermissionEvidence
} from './notification-permission-probe'

export function registerNotificationHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  ipcMain.removeHandler('notifications:getDesktopAwayState')
  ipcMain.handle('notifications:getDesktopAwayState', () => readDesktopAwayState(powerMonitor))
  resetNotificationPermissionEvidence()

  ipcMain.removeHandler('notifications:openSystemSettings')
  ipcMain.removeHandler('notifications:getPermissionStatus')
  ipcMain.removeHandler('notifications:probeDelivery')
  ipcMain.handle('notifications:openSystemSettings', (): void => {
    openNotificationSystemSettings()
  })

  // Why: Electron's main process can't read macOS auth status; expose only what we can observe (platform support + whether we've prompted).
  const getPermissionStatus = (): NotificationPermissionStatusResult => ({
    supported: Notification.isSupported(),
    platform: process.platform,
    requested: store.getUI().notificationPermissionRequested === true
  })

  ipcMain.handle('notifications:getPermissionStatus', getPermissionStatus)
  ipcMain.handle(
    'notifications:probeDelivery',
    async (_event, args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> => {
      // Why: macOS-only — Windows/Linux have no first-use permission dialog, so the onboarding card never renders there.
      if (process.platform !== 'darwin' || !Notification.isSupported()) {
        return { state: 'unsupported', authoritative: false }
      }
      // Why: probes surface the macOS permission dialog, so mark startup registration done to avoid a second prompt later.
      if (store.getUI().notificationPermissionRequested !== true) {
        store.updateUI({ notificationPermissionRequested: true })
      }
      // Preferred source: the bundled helper reads real auth silently, so polling tracks System Settings changes without banners.
      const authorization = await readNotificationAuthorizationStatus()
      if (authorization === 'authorized') {
        recordNotificationDeliveryOutcome('delivered')
        return { state: 'delivered', authoritative: true }
      }
      if (authorization === 'denied') {
        recordNotificationDeliveryOutcome('failed')
        return { state: 'blocked', authoritative: true }
      }
      if (authorization === 'not-determined') {
        // Why: the dialog only appears once something asks; fire one probe per session to trigger it, then report pending.
        if (!hasTriggeredPermissionDialogThisSession()) {
          void probeNotificationDelivery()
        }
        return { state: 'awaiting-decision', authoritative: true }
      }
      // Helper unavailable or 'unknown': fall back to scheduling-based probes with session caching to avoid repeated banners.
      const lastObservedDeliveryOutcome = getLastObservedDeliveryOutcome()
      if (!args?.force && lastObservedDeliveryOutcome !== null) {
        return {
          state: lastObservedDeliveryOutcome === 'delivered' ? 'delivered' : 'blocked',
          authoritative: false
        }
      }
      return probeNotificationDelivery()
    }
  )

  ipcMain.removeHandler('notifications:dismiss')
  ipcMain.handle('notifications:dismiss', (_event, ids: string[]): NotificationDismissResult => {
    const uniqueIds = Array.from(
      new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))
    )
    let dismissed = 0
    for (const id of uniqueIds) {
      const entry = activeNotificationsById.get(id)
      if (entry) {
        entry.notification.close()
        entry.release()
        dismissed += 1
      }
      runtime?.dismissMobileNotification(id)
    }
    return { dismissed }
  })

  const deliveryService = createNotificationDeliveryService({
    readNotificationSettings: () => store.getSettings().notifications,
    findActiveWindow: () =>
      BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null,
    isWindowVisible: isMainWindowVisible,
    setTrayAttention,
    isNotificationSupported: () => Notification.isSupported(),
    dispatchMobileNotification: runtime
      ? (payload) => runtime.dispatchMobileNotification(payload)
      : null,
    readAuthorizationStatus: readNotificationAuthorizationStatus,
    recordDeliveryOutcome: recordNotificationDeliveryOutcome,
    deliverNative: deliverNativeNotification,
    platform: process.platform,
    now: () => Date.now()
  })

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (
      _event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> =>
      deliveryService.dispatch(args)
  )

  registerNotificationSoundHandlers(store)
}
