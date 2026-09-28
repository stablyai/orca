import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { desktopNotificationStreamUnsubscribe } from './desktop-notification-stream-operations'
import { dismissHostPushNotification } from './push-socket-dismissal'
import type { DismissNotificationEvent } from './desktop-notification-events'
import type { RpcClient } from '../transport/rpc-client'

export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from './notification-permissions'

type SubscribeResult = {
  type: 'ready'
  subscriptionId: string
}

export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  let subscriptionId: string | null = null
  let disposed = false

  function unsubscribeServer(id: string) {
    if (client.getState() === 'connected') {
      // The reply is never read: the stream is already gone locally either way.
      desktopNotificationStreamUnsubscribe.request(client, { subscriptionId: id }).catch(() => {})
    }
  }

  const params = { includeDesktopSuppressed: true }
  const unsubscribeStream = client.subscribe('notifications.subscribe', params, (data: unknown) => {
    const event = data as DismissNotificationEvent | SubscribeResult | { type: string }
    // No dispose-before-ready arm: every transport detaches this listener inside
    // `unsubscribeStream()`, so a callback that runs at all runs before disposal.
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      // A max watermark asks only which delivered pushes are stale; socket history
      // never becomes a second OS-notification delivery route.
      void requestNotificationCatchup(client, hostId, () => disposed).catch(() => {})
      return
    }
    if (!disposed && event.type === 'dismiss') {
      void dismissHostPushNotification(event as DismissNotificationEvent, hostId).catch(() => {})
    }
  })

  return () => {
    disposed = true
    unsubscribeStream()
    if (subscriptionId) {
      unsubscribeServer(subscriptionId)
    }
  }
}
