import type { MobileNotificationEvent } from '../../runtime-mobile-notification-controller'

export function createNotificationStreamFilter(includeDesktopSuppressed = false) {
  return (event: MobileNotificationEvent): boolean =>
    includeDesktopSuppressed ||
    event.type !== 'notification' ||
    (event.desktopAllowed !== false && event.legacySocketAllowed !== false)
}
