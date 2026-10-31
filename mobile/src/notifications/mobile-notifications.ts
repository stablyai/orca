import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { dismissHostPushNotification } from './push-socket-dismissal'
import type { DismissNotificationEvent } from './desktop-notification-events'
import type { RpcClient } from '../transport/rpc-client'
import { waitForPushFallback } from './push-fallback'
import { getHostPushSupported, getHostPushSupportCompletion } from './push-registration'
import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { presentForegroundPush } from './android-foreground-push'
import {
  DESKTOP_NOTIFICATION_CHANNEL_ID,
  ensureDesktopNotificationChannel
} from './desktop-notification-channel'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'
import {
  allowsMobilePushDelivery,
  mobilePushAlertContent
} from '../../../src/shared/mobile-push-alert'
import { reserveNotificationCooldown } from '../../../src/shared/notification-burst-cooldown'
import type { MobileNotificationDispatchEvent } from '../../../src/main/runtime/runtime-mobile-notification-controller'

export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from './notification-permissions'

export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  let disposed = false
  const pending = new AbortController()
  const recentNotifications = new Map<string, number>()

  async function present(event: MobileNotificationDispatchEvent): Promise<void> {
    const content = mobilePushAlertContent(event)
    if (!content) {
      return
    }
    const support = getHostPushSupportCompletion(hostId, client)
    const currentConnection = () =>
      !disposed &&
      support !== null &&
      !support.signal.aborted &&
      getHostPushSupportCompletion(hostId, client) === support
    let noToken = false
    const isCurrent = () =>
      currentConnection() && (noToken || getHostPushSupported(hostId) === false)
    async function prepareFallback(): Promise<boolean> {
      noToken = false
      if (!currentConnection()) {
        return false
      }
      if (getHostPushSupported(hostId) !== false) {
        noToken = (await waitForPushFallback([support], pending.signal)) === 'no-token'
      }
      return isCurrent()
    }
    if (!(await prepareFallback())) {
      return
    }
    const preferences = await loadNotificationDeliveryPreferences()
    if (!allowsMobilePushDelivery(preferences, event)) {
      return
    }
    const host = (await loadHostCatalog()).find((entry) => entry.id === hostId)
    const hostFingerprint = host && deriveHostFingerprint(host.publicKeyB64)
    if (!hostFingerprint || disposed) {
      return
    }
    if (
      event.emittedAt !== undefined &&
      !reserveNotificationCooldown(
        recentNotifications,
        event.attentionKey ?? event.worktreeId ?? 'global',
        event.emittedAt
      )
    ) {
      return
    }
    const channelId = `${DESKTOP_NOTIFICATION_CHANNEL_ID}${preferences.sound ? '' : '-silent'}`
    await ensureDesktopNotificationChannel()
    if (disposed) {
      return
    }
    await presentForegroundPush(
      JSON.stringify([hostFingerprint, event.notificationEpoch, event.notificationSeq]),
      {
        title: content.title,
        body: content.body,
        sound: preferences.sound ? 'default' : null,
        data: {
          kind: 'alert',
          hostFingerprint,
          notificationId: event.notificationId,
          notificationEpoch: event.notificationEpoch,
          notificationSeq: event.notificationSeq,
          worktreeId: event.worktreeId,
          paneKey: event.paneKey,
          executionHost: event.executionHost,
          channelId
        }
      },
      prepareFallback,
      isCurrent
    )
  }

  const params = { includeDesktopSuppressed: true }
  const unsubscribeStream = client.subscribe('notifications.subscribe', params, (data: unknown) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notifications.subscribe emits the runtime's dispatch/dismiss union or transport control frames, with no transformation of notification fields.
    const event = data as
      | MobileNotificationDispatchEvent
      | DismissNotificationEvent
      | { type: 'ready' | 'end' | 'error' }
    // Transport detaches the listener on unsubscribe, so any callback still running precedes disposal.
    if (event.type === 'ready') {
      // Use the watermark only to dismiss stale pushes; socket history must not become another OS delivery route.
      void requestNotificationCatchup(client, hostId, () => disposed).catch(() => {})
      return
    }
    if (!disposed && event.type === 'dismiss') {
      void dismissHostPushNotification(event, hostId).catch(() => {})
    }
    if (!disposed && event.type === 'notification') {
      void present(event).catch((error: unknown) => {
        console.warn('[push] Live notification presentation failed', error)
      })
    }
  })

  return () => {
    disposed = true
    pending.abort()
    unsubscribeStream()
  }
}
