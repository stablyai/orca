import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { dismissHostPushNotification } from './push-socket-dismissal'
import { presentSocketNotificationFallback } from './push-socket-fallback'
import type {
  DesktopNotificationDispatchEvent,
  DismissNotificationEvent
} from './desktop-notification-events'
import type { RpcClient } from '../transport/rpc-client'

export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from './notification-permissions'

export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  let disposed = false

  const params = { includeDesktopSuppressed: true }
  const unsubscribeStream = client.subscribe('notifications.subscribe', params, (data: unknown) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every frame a shipped host or the transport sends is an object with a string `type`: the host's `ready`, `end`, notification and dismiss events, or the transport's `error`.
    const event = data as DismissNotificationEvent | { type: string }
    // Transport detaches the listener on unsubscribe, so any callback still running precedes disposal.
    if (event.type === 'ready') {
      // Use the watermark only to dismiss stale pushes; socket history must not become another OS delivery route.
      void requestNotificationCatchup(client, hostId, () => disposed).catch(() => {})
      return
    }
    if (!disposed && event.type === 'dismiss') {
      void dismissHostPushNotification(event as DismissNotificationEvent, hostId).catch(() => {})
      return
    }
    if (!disposed && event.type === 'notification') {
      void presentSocketNotificationFallback(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a notification frame on this stream is the desktop dispatch event.
        event as DesktopNotificationDispatchEvent,
        hostId,
        () => disposed,
        client
      ).catch(() => {})
    }
  })

  return () => {
    disposed = true
    unsubscribeStream()
  }
}
