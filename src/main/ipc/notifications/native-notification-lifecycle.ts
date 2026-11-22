import type { Notification } from 'electron'
import { closeDesktopNotification } from '../../notifications/desktop-notification'

const NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS = 2500
const NOTIFICATION_RELEASE_FALLBACK_MS = 5 * 60 * 1000
const NOTIFICATION_HISTORY_LIMIT = 256
const retainedHistoryNotifications = new Map<Notification, () => void>()

// Keep strong references so GC cannot discard displayed notifications and click handlers.
export const activeNotifications = new Set<Notification>()
export const activeNotificationsById = new Map<
  string,
  { notification: Notification; release: () => void }
>()

export function retainNotificationUntilRelease(
  notification: Notification,
  onRelease?: () => void
): () => void {
  activeNotifications.add(notification)
  let released = false
  let releaseTimer: ReturnType<typeof setTimeout> | null = null

  function release(): void {
    if (released) {
      return
    }
    released = true
    activeNotifications.delete(notification)
    notification.removeListener('close', onClose)
    retainedHistoryNotifications.delete(notification)
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    onRelease?.()
  }

  function onClose(details?: Electron.NotificationCloseEventParams): void {
    // Windows hides the banner before the notification leaves Action Center.
    // If explicitly canceled/dismissed by the user, release immediately.
    // Otherwise (timed out or reason undefined in Electron Windows), retain for Action Center click.
    if (process.platform === 'win32') {
      if (details?.reason === 'userCanceled') {
        release()
        return
      }
      return
    }
    release()
  }

  notification.on('close', onClose)
  if (process.platform === 'win32' || process.platform === 'linux') {
    retainedHistoryNotifications.set(notification, release)
    if (retainedHistoryNotifications.size > NOTIFICATION_HISTORY_LIMIT) {
      const oldest = retainedHistoryNotifications.entries().next().value
      if (oldest) {
        // Remove the toast too, so history never contains a target whose handler we discarded.
        closeDesktopNotification(oldest[0])
        oldest[1]()
      }
    }
  } else {
    releaseTimer = setTimeout(release, NOTIFICATION_RELEASE_FALLBACK_MS)
    if (typeof releaseTimer.unref === 'function') {
      releaseTimer.unref()
    }
  }

  return release
}

export function trackNotificationDisplay(notification: Notification): {
  result: Promise<boolean>
  start: () => void
  cancel: () => void
} {
  const { promise: result, resolve } = Promise.withResolvers<boolean>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function settle(displayed: boolean): void {
    if (settled) {
      return
    }
    settled = true
    notification.removeListener('show', onShow)
    notification.removeListener('failed', cancel)
    notification.removeListener('close', cancel)
    clearTimeout(timer)
    resolve(displayed)
  }

  function onShow(): void {
    settle(true)
  }

  function cancel(): void {
    settle(false)
  }

  notification.once('show', onShow)
  notification.once('failed', cancel)
  notification.once('close', cancel)
  return {
    result,
    start: () => {
      if (!settled) {
        timer = setTimeout(cancel, NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS)
      }
    },
    cancel
  }
}

export function logNativeNotificationFailure(context: string, error?: string): void {
  console.warn(
    `[notifications] ${context} notification failed to show${error ? `: ${error}` : '.'}`
  )
}
