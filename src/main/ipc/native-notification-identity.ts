/**
 * Identity macOS Notification Center can see: an `id` (UNNotificationRequest identifier) and a
 * `groupId` (threadIdentifier) per pane, so a delivered notification can be removed by name.
 *
 * Why not rely on close(): it needs the live Notification object, which main releases after five
 * minutes and loses on restart, so older notifications piled up per pane (#26732).
 */
import { Notification } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'

/** Group every plain pane notification under one thread, so a pane read clears them all. */
export function paneNotificationGroupId(paneKey: string): string {
  return `pane:${paneKey}`
}

export function buildNativeNotificationIdentity(request: NotificationDispatchRequest): {
  id?: string
  groupId?: string
} {
  // Why darwin only: on Windows these map to toast Tag/Group, which cap length and change replace
  // semantics; that path keeps its close()-based dismissal.
  if (process.platform !== 'darwin') {
    return {}
  }
  const id =
    request.notificationId ??
    (request.source === 'terminal-bell' && request.paneKey
      ? `terminal-bell:${request.paneKey}`
      : undefined)
  // Why structured alerts stay out of the group: a positioned alert is retired only by a read that
  // covers it, and removeGroup would clear it on any pane read.
  const groupId =
    request.paneKey && !request.structuredOrigin
      ? paneNotificationGroupId(request.paneKey)
      : undefined
  return { ...(id ? { id } : {}), ...(groupId ? { groupId } : {}) }
}

/** Removes delivered notifications by identifier; works without a live object or after restart. */
export function removeDeliveredNotifications(ids: Iterable<string>, paneKeys: string[]): void {
  if (process.platform !== 'darwin') {
    return
  }
  const idList = [...ids]
  if (idList.length > 0) {
    Notification.remove(idList)
  }
  for (const paneKey of paneKeys) {
    Notification.removeGroup(paneNotificationGroupId(paneKey))
  }
}
