// Click routes of shown notifications, newest last. Kept past the banner's retention window so the
// shortcut still reaches an agent that has waited longer; cleared on open, read, or replacement.
import {
  attentionOriginWasRead,
  type StructuredAttentionOrigin,
  type StructuredAttentionRead
} from '../../../shared/agent-session/view/agent-session-attention'
import { notificationWasAcknowledged } from '../../../shared/notifications/notification-attention-acknowledgement'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDispatchRequest
} from '../../../shared/notifications/notification-settings-types'

const MAX_OPENABLE_NOTIFICATIONS = 50

type OpenableNotificationKey = {
  id?: string
  paneKey?: string
  /** Journal position of a structured alert; only a read covering it retires the route. */
  origin?: StructuredAttentionOrigin
} & Pick<NotificationDispatchRequest, 'worktreeId' | 'executionHost' | 'workspaceExecutionHostId'>
export type OpenableNotificationPaneRead = { paneKey: string; read?: StructuredAttentionRead }
type OpenableNotification = OpenableNotificationKey & { open: () => void }

const openableNotifications: OpenableNotification[] = []

/** Register a shown notification's open route; the returned function unregisters it. */
export function registerOpenableNotification(
  open: () => void,
  key: OpenableNotificationKey = {}
): () => void {
  if (key.id) {
    forgetOpenableNotifications([key.id])
  }
  const entry: OpenableNotification = { ...key, open }
  openableNotifications.push(entry)
  if (openableNotifications.length > MAX_OPENABLE_NOTIFICATIONS) {
    openableNotifications.shift()
  }
  return () => {
    const index = openableNotifications.indexOf(entry)
    if (index !== -1) {
      openableNotifications.splice(index, 1)
    }
  }
}

/** Drop notifications Orca retired as read, so the shortcut skips work the user already saw.
 * A pane read retires that pane's unpositioned notifications, including id-less terminal bells,
 * and positioned alerts only when the read covers their journal position. Mirroring the announced
 * registry's rule here keeps routes retirable after that registry has evicted their ids. */
export function forgetOpenableNotifications(
  ids: Iterable<string>,
  paneReads: readonly OpenableNotificationPaneRead[] = []
): void {
  const retiredIds = new Set(ids)
  const wasRead = ({ id, paneKey, origin }: OpenableNotification): boolean =>
    (id !== undefined && retiredIds.has(id)) ||
    paneReads.some(
      ({ paneKey: readPaneKey, read }) =>
        readPaneKey === paneKey &&
        (origin === undefined || (read !== undefined && attentionOriginWasRead(origin, read)))
    )
  for (let index = openableNotifications.length - 1; index >= 0; index -= 1) {
    if (wasRead(openableNotifications[index])) {
      openableNotifications.splice(index, 1)
    }
  }
}

/** Drop notifications an attention acknowledgement retired: the announcements it took, plus any
 * route its rule covers, so routes stay retirable after the announced registry evicted their ids. */
export function forgetAcknowledgedOpenableNotifications(
  acknowledgement: NotificationAttentionAcknowledgement,
  executionHost: NotificationDispatchRequest['executionHost'],
  retired: readonly { id: string }[] = []
): void {
  forgetOpenableNotifications(retired.map((entry) => entry.id))
  for (let index = openableNotifications.length - 1; index >= 0; index -= 1) {
    if (notificationWasAcknowledged(openableNotifications[index], acknowledgement, executionHost)) {
      openableNotifications.splice(index, 1)
    }
  }
}

export function hasOpenableNotification(): boolean {
  return openableNotifications.length > 0
}

/** Open the newest notification as if it were clicked; false when none remains. */
export function openLatestNotification(): boolean {
  const entry = openableNotifications.pop()
  if (!entry) {
    return false
  }
  entry.open()
  return true
}
