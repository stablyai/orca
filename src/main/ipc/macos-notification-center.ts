import { Notification, type NotificationConstructorOptions } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import {
  worktreeAnnouncementSubject,
  type AnnouncedNotification
} from '../notifications/announced-notification-registry'

function paneGroupId(paneKey: string): string {
  return `pane:${paneKey}`
}

export function macosNotificationIdentity(
  request: NotificationDispatchRequest
): Pick<NotificationConstructorOptions, 'id' | 'groupId'> {
  // Windows toast Tag/Group has different replacement rules.
  if (process.platform !== 'darwin') {
    return {}
  }
  // Structured alerts retire only on reads covering their journal position; keep once-only IDs.
  if (request.structuredOrigin) {
    return request.notificationId ? { id: request.notificationId } : {}
  }
  // Reused IDs bind clicks to the first shown Electron object, even after release.
  // Pane-less worktree announcements group under their synthetic subject, so the
  // dismissal path can still find them after their live object is released.
  const subject =
    request.paneKey ??
    (request.worktreeId ? worktreeAnnouncementSubject(request.worktreeId) : undefined)
  return subject !== undefined ? { groupId: paneGroupId(subject) } : {}
}

// Remove without a live object; close cannot work after retention expiry or restart.
export function removeReadMacosNotifications(
  paneKey: string,
  retired: readonly AnnouncedNotification[],
  options?: {
    /** Skip the group removal when the pane group still holds another worktree's notifications. */
    onlyIds?: boolean
  }
): void {
  if (process.platform !== 'darwin') {
    return
  }
  if (!options?.onlyIds) {
    Notification.removeGroup(paneGroupId(paneKey))
  }
  const ids = retired.filter((entry) => entry.origin).map((entry) => entry.id)
  if (ids.length > 0) {
    Notification.remove(ids)
  }
}
