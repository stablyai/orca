import { Notification } from 'electron'
import type { Store } from '../persistence'
import { activeNotifications, logNativeNotificationFailure } from './native-notification-lifecycle'
import { recordNotificationDeliveryOutcome } from './notification-permission-probe'
import { openNotificationSystemSettings } from './notification-system-settings-link'

/**
 * On first launch (macOS permission 'not-determined'), show a welcome notification to trigger the system prompt.
 *
 * Why: macOS requires at least one notification attempt before it will prompt to allow/deny.
 */
export function triggerStartupNotificationRegistration(store: Store): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) {
    return
  }
  // Why: fire once per install, not on every launch where status stays not-determined (e.g. user dismisses the dialog).
  const ui = store.getUI()
  if (ui.notificationPermissionRequested) {
    return
  }
  store.updateUI({ notificationPermissionRequested: true })

  const notification = new Notification({
    title: 'Orca is ready to notify you',
    body: 'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
  })

  // Why: prevent GC from collecting the notification and its click handler while it's still visible.
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

  // Why: the body reads like an actionable "Allow notifications…" prompt, so clicking opens macOS Notification Settings.
  function onClick(): void {
    cleanup()
    openNotificationSystemSettings()
  }

  function onShow(): void {
    // Why: close after a delay so the banner doesn't linger; the macOS permission sheet is separate and unaffected.
    closeTimer = setTimeout(cleanup, 8000)
    if (typeof closeTimer.unref === 'function') {
      closeTimer.unref()
    }
  }

  function onFailed(_event: unknown, error?: string): void {
    // Why: Electron 42 requires code-signed macOS apps for UNNotification delivery; unsigned builds fail here.
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
