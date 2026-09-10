import { reserveNotificationCooldown } from '../../../../shared/notification-burst-cooldown'
import type { MobileNotificationEvent } from '../../runtime-mobile-notification-controller'

export function createNotificationStreamFilter(includeDesktopSuppressed = false) {
  const recent = new Map<string, number>()
  return (event: MobileNotificationEvent): boolean => {
    if (includeDesktopSuppressed || event.type !== 'notification') {
      return true
    }
    if (event.desktopAllowed === false) {
      return false
    }
    // Old phones rely on the host for workspace-wide burst suppression.
    return (
      event.emittedAt === undefined ||
      reserveNotificationCooldown(recent, event.worktreeId ?? 'global', event.emittedAt)
    )
  }
}
