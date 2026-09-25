import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { dismissHostPushNotification } from './push-socket-dismissal'
import type { DismissNotificationEvent } from './desktop-notification-events'
import type { RpcClient } from '../transport/rpc-client'

export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from './notification-permissions'

export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  let disposed = false

  const params = { includeDesktopSuppressed: true }
  // The transport releases the host registration with the id from the current `ready`.
  const unsubscribeStream = client.subscribe('notifications.subscribe', params, (data: unknown) => {
    const event = data as DismissNotificationEvent | { type: string }
    // No dispose-before-ready arm: every transport detaches this listener inside
    // `unsubscribeStream()`, so a callback that runs at all runs before disposal.
    if (event.type === 'ready') {
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
  }
}
