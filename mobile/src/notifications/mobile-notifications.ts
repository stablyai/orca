import { requestNotificationCatchup } from './push-dismissal-reconciliation'
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
      client.sendRequest('notifications.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  const params = { includeDesktopSuppressed: true }
  const unsubscribeStream = client.subscribe('notifications.subscribe', params, (data: unknown) => {
    const event = data as DismissNotificationEvent | SubscribeResult | { type: string }
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      if (disposed) {
        unsubscribeServer(subscriptionId)
        unsubscribeStream()
        return
      }
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
