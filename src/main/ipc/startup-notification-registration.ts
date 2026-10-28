import { Notification } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import type { Store } from '../persistence'
import { activeNotifications, logNativeNotificationFailure } from './native-notification-lifecycle'
import { recordNotificationDeliveryOutcome } from './notification-permission-probe'
import { openNotificationSystemSettings } from './notification-system-settings-link'

/** macOS prompts for notification permission only after a delivery attempt. */
export function triggerStartupNotificationRegistration(store: Store): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) {
    return
  }
  // Ask once per install even if the permission dialog is dismissed.
  const ui = store.getUI()
  if (ui.notificationPermissionRequested) {
    return
  }
  store.updateUI({ notificationPermissionRequested: true })

  const notification = new Notification({
    title: translateMain('notifications.startupRegistration.title', 'Orca is ready to notify you'),
    body: translateMain(
      'notifications.startupRegistration.body',
      'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
    )
  })

  // Retain the notification and its click handler until it closes.
  activeNotifications.add(notification)

  let handled = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null

  function clearStartupTimers(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  function cleanup(): void {
    if (handled) {
      return
    }
    handled = true
    clearStartupTimers()
    activeNotifications.delete(notification)
    notification.removeListener('click', onClick)
    notification.removeListener('show', onShow)
    notification.removeListener('failed', onFailed)
    notification.close()
  }

  function onClick(): void {
    cleanup()
    openNotificationSystemSettings()
  }

  function onShow(): void {
    // Retire the banner independently of the macOS permission sheet.
    closeTimer = setTimeout(cleanup, 8000)
    if (typeof closeTimer.unref === 'function') {
      closeTimer.unref()
    }
  }

  function onFailed(_event: unknown, error?: string): void {
    // Electron 42 rejects notification delivery from unsigned macOS builds.
    logNativeNotificationFailure('startup registration', error)
    recordNotificationDeliveryOutcome('failed')
    cleanup()
  }

  notification.on('click', onClick)
  notification.on('show', onShow)
  notification.on('failed', onFailed)

  // Fallback in case macOS doesn't fire the 'show' event (e.g. user denies).
  fallbackTimer = setTimeout(cleanup, 10_000)
  if (typeof fallbackTimer.unref === 'function') {
    fallbackTimer.unref()
  }

  notification.show()
}
