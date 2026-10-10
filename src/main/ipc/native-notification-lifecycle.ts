import type { Notification } from 'electron'

const NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS = 2500
const NOTIFICATION_RELEASE_FALLBACK_MS = 5 * 60 * 1000

// Why: keep a strong reference so GC can't collect notifications (and their click handlers) before the user interacts with them.
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
    notification.removeListener('close', release)
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    onRelease?.()
  }

  notification.on('close', release)
  releaseTimer = setTimeout(release, NOTIFICATION_RELEASE_FALLBACK_MS)
  if (typeof releaseTimer.unref === 'function') {
    releaseTimer.unref()
  }

  return release
}

export function waitForNotificationDisplay(notification: Notification): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    function cleanup(): void {
      notification.removeListener('show', onShow)
      notification.removeListener('failed', onFailed)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    function settle(displayed: boolean): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(displayed)
    }

    function onShow(): void {
      settle(true)
    }

    function onFailed(): void {
      settle(false)
    }

    notification.once('show', onShow)
    notification.once('failed', onFailed)
    timer = setTimeout(() => settle(false), NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS)
  })
}

export function logNativeNotificationFailure(context: string, error?: string): void {
  console.warn(
    `[notifications] ${context} notification failed to show${error ? `: ${error}` : '.'}`
  )
}
