import type { Notification } from 'electron'

const NOTIFICATION_RELEASE_FALLBACK_MS = 5 * 60 * 1000
export const MAX_ACTIVE_NATIVE_NOTIFICATIONS = 128

type RetainedNotification = {
  evict: () => void
  release: () => void
}

export type RetainedNativeNotificationIdEntry = {
  notification: Notification
  release: () => void
}

const activeNotifications = new Map<Notification, RetainedNotification>()
const activeNotificationsById = new Map<string, RetainedNativeNotificationIdEntry>()

export function retainNativeNotification(
  notification: Notification,
  onRelease?: () => void,
  onEvict?: () => void,
  options: { fallbackMs?: number | null } = {}
): () => void {
  while (activeNotifications.size >= MAX_ACTIVE_NATIVE_NOTIFICATIONS) {
    const oldest = activeNotifications.values().next()
    if (oldest.done) {
      break
    }
    oldest.value.evict()
  }

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

  function evict(): void {
    try {
      onEvict?.()
    } finally {
      try {
        notification.close()
      } finally {
        release()
      }
    }
  }

  activeNotifications.set(notification, { evict, release })
  notification.on('close', release)
  const fallbackMs =
    options.fallbackMs === undefined ? NOTIFICATION_RELEASE_FALLBACK_MS : options.fallbackMs
  if (fallbackMs !== null) {
    releaseTimer = setTimeout(release, fallbackMs)
    releaseTimer.unref?.()
  }
  return release
}

export function getRetainedNativeNotificationById(
  id: string
): RetainedNativeNotificationIdEntry | undefined {
  return activeNotificationsById.get(id)
}

export function setRetainedNativeNotificationId(
  id: string,
  entry: RetainedNativeNotificationIdEntry
): void {
  activeNotificationsById.set(id, entry)
}

export function deleteRetainedNativeNotificationId(
  id: string,
  expected: RetainedNativeNotificationIdEntry
): void {
  if (activeNotificationsById.get(id) === expected) {
    activeNotificationsById.delete(id)
  }
}

export function getActiveNativeNotificationCountForTest(): number {
  return activeNotifications.size
}

export function clearActiveNativeNotificationsForTest(): void {
  for (const entry of Array.from(activeNotifications.values())) {
    entry.evict()
  }
  activeNotificationsById.clear()
}
