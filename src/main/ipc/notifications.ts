import { BrowserWindow, Notification, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult
} from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildNotificationOptions } from './notification-options'
import { readNotificationAuthorizationStatus } from './notification-authorization-status'
import { setTrayAttention } from '../tray/system-tray'
import { isMainWindowVisible } from '../window/main-window-visibility'
import { activeNotificationsById } from './native-notification-lifecycle'
import { deliverNativeNotification } from './native-notification-delivery'
import { reserveNotificationCooldown } from './notification-burst-cooldown'
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
  const recentDesktopNotifications = new Map<string, number>()
  const recentMobileNotifications = new Map<string, number>()
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

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (
      _event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
      // Why: light the tray attention dot before the cooldown/focus/enabled gates so they can't hold it back (clears on window show/restore; see index.ts).
      if (args.source === 'agent-task-complete' || args.source === 'terminal-bell') {
        const activeWindow = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
        if (!isMainWindowVisible(activeWindow)) {
          setTrayAttention(true)
        }
      }

      const settings = store.getSettings().notifications
      if (!settings.enabled) {
        return { delivered: false, reason: 'disabled' }
      }

      if (
        (args.source === 'agent-task-complete' && !settings.agentTaskComplete) ||
        (args.source === 'terminal-bell' && !settings.terminalBell)
      ) {
        return { delivered: false, reason: 'source-disabled' }
      }

      const notificationOptions = buildNotificationOptions(args)

      // Why: desktop focus only means this computer sees the worktree; the paired phone may still need the alert.
      if (runtime && args.source !== 'test') {
        const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
        if (reserveNotificationCooldown(recentMobileNotifications, dedupeKey, Date.now())) {
          runtime.dispatchMobileNotification({
            type: 'notification',
            source: args.source,
            title: notificationOptions.title,
            body: notificationOptions.body,
            worktreeId: args.worktreeId,
            ...(args.notificationId ? { notificationId: args.notificationId } : {})
          })
        }
      }

      const browserWindow =
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
      if (
        settings.suppressWhenFocused &&
        args.isActiveWorktree &&
        browserWindow &&
        browserWindow.isFocused()
      ) {
        return { delivered: false, reason: 'suppressed-focus' }
      }

      // Why: the Settings test button is an explicit, often-repeated user action, so it bypasses burst dedupe.
      if (args.source !== 'test') {
        // Dedupe by worktree, not source — agent-finish and terminal-bell often fire in one chunk; surface only the first.
        const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
        if (!reserveNotificationCooldown(recentDesktopNotifications, dedupeKey, Date.now())) {
          return { delivered: false, reason: 'cooldown' }
        }
      }

      if (!Notification.isSupported()) {
        return { delivered: false, reason: 'not-supported' }
      }

      if (process.platform !== 'darwin') {
        return deliverNativeNotification(args, notificationOptions, settings)
      }
      // Why: macOS silently swallows notifications while permission is denied/undecided (verified macOS 26); skip so the renderer can show a fallback.
      return readNotificationAuthorizationStatus().then((authorization) => {
        if (authorization === 'denied' || authorization === 'not-determined') {
          recordNotificationDeliveryOutcome('failed')
          return { delivered: false, reason: 'blocked-by-system' }
        }
        return deliverNativeNotification(args, notificationOptions, settings)
      })
    }
  )

  registerNotificationSoundHandlers(store)
}
