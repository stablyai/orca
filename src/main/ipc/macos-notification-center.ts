import { Notification, type NotificationConstructorOptions } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import type { AnnouncedNotification } from '../notifications/announced-notification-registry'

function paneGroupId(paneKey: string): string {
  return `pane:${paneKey}`
}

export function macosNotificationIdentity(
  request: NotificationDispatchRequest
): Pick<NotificationConstructorOptions, 'id' | 'groupId'> {
  // Why darwin only: Windows maps these to toast Tag/Group, which have their own replace rules.
  if (process.platform !== 'darwin' || !request.paneKey) {
    return {}
  }
  // Why: only a read covering its journal position retires it, so it leaves by its once-only id.
  if (request.structuredOrigin) {
    return request.notificationId ? { id: request.notificationId } : {}
  }
  // Why no id: Electron routes a click to the first object shown with an id, even a released one.
  return { groupId: paneGroupId(request.paneKey) }
}

/** Removes a read pane's thread and the structured alerts this read retired. */
// Why: close() needs the live object (released at 5 min, gone after restart); this needs none.
export function removeReadMacosNotifications(
  paneKey: string,
  retired: readonly AnnouncedNotification[]
): void {
  if (process.platform !== 'darwin') {
    return
  }
  Notification.removeGroup(paneGroupId(paneKey))
  const ids = retired.filter((entry) => entry.origin).map((entry) => entry.id)
  if (ids.length > 0) {
    Notification.remove(ids)
  }
}
