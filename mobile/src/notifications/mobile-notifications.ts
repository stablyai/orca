import type { RpcClient } from '../transport/rpc-client'
import {
  configureNotificationChannel,
  startLocalNotificationDelivery,
  type DismissNotificationEvent,
  type NotificationEvent
} from './mobile-notification-delivery'
import {
  isMobileNotificationHostIdRetainable,
  measureMobileNotificationDeliveryBytes
} from './mobile-notification-retention'
import {
  createSeenNotificationGuard,
  loadLastSeenSeq,
  saveLastSeenSeq,
  seenKeyForEvent
} from './notification-reconnect-catchup'

export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  setScheduledNotificationsMaxForTests
} from './mobile-notification-delivery'
export type { NotificationPermissionState } from './mobile-notification-delivery'

type SubscribeResult = {
  type: 'ready'
  subscriptionId: string
}

// Per-connection subscription; a reconnect `ready` triggers watermarked catch-up (#8129) so already-pushed events aren't re-sent.
export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  if (!isMobileNotificationHostIdRetainable(hostId)) {
    return () => {}
  }
  configureNotificationChannel()

  let subscriptionId: string | null = null
  let disposed = false
  // Highest seq delivered (live or replay) this connection; persisted per-host so cold start resumes from the right cut.
  let lastDeliveredSeq = 0
  let watermarkBlockedThroughSeq: number | null = null
  // Why: defense-in-depth dedup for replayed events if the desktop's bounded buffer evicted across a reconnect boundary.
  const seenReplay = createSeenNotificationGuard()

  function eventSequence(event: NotificationEvent | DismissNotificationEvent): number | null {
    return typeof event.notificationSeq === 'number' && Number.isSafeInteger(event.notificationSeq)
      ? event.notificationSeq
      : null
  }

  function advanceDeliveredWatermark(
    event: NotificationEvent | DismissNotificationEvent,
    replay: boolean
  ): void {
    const seq = eventSequence(event)
    if (seq == null || seq <= lastDeliveredSeq) {
      return
    }
    if (watermarkBlockedThroughSeq !== null) {
      if (!replay) {
        watermarkBlockedThroughSeq = Math.max(watermarkBlockedThroughSeq, seq)
        return
      }
      if (seq < watermarkBlockedThroughSeq) {
        return
      }
      watermarkBlockedThroughSeq = null
    }
    lastDeliveredSeq = seq
    void saveLastSeenSeq(hostId, lastDeliveredSeq)
  }

  function deliverLive(
    event: NotificationEvent | DismissNotificationEvent,
    replay = false
  ): Promise<void> {
    const delivery = startLocalNotificationDelivery(event, hostId)
    if (!delivery) {
      const seq = eventSequence(event)
      if (seq !== null && seq > lastDeliveredSeq) {
        // Why: advancing past a dropped event would make reconnect catch-up permanently skip it.
        watermarkBlockedThroughSeq = Math.max(watermarkBlockedThroughSeq ?? seq, seq)
      }
      return Promise.resolve()
    }
    // Why (#8129): only accepted work is seen; overload drops remain eligible for reconnect catch-up.
    const key = seenKeyForEvent(event)
    if (key) {
      seenReplay.add(key)
    }
    advanceDeliveredWatermark(event, replay)
    return delivery
  }

  // Why: desktop cuts by seq > lastSeenSeq, so re-fetching from the watermark is idempotent (seenReplay guards residual overlap).
  async function fetchMissed(): Promise<void> {
    if (disposed) {
      return
    }
    const missed = await client
      .sendRequest('notifications.getMissedSince', { lastSeenSeq: lastDeliveredSeq })
      .then((response) => {
        if (!response.ok) {
          return []
        }
        const result = response.result as { notifications?: unknown[] } | undefined
        return Array.isArray(result?.notifications) ? result.notifications : []
      })
      .catch(() => [])
    for (const raw of missed) {
      const event = raw as NotificationEvent | DismissNotificationEvent
      if (measureMobileNotificationDeliveryBytes(event, hostId) === null) {
        await deliverLive(event, true)
        continue
      }
      const key = seenKeyForEvent(event)
      if (key && seenReplay.has(key)) {
        advanceDeliveredWatermark(event, true)
        continue
      }
      if (event.type === 'notification') {
        await deliverLive(event, true)
      } else if (event.type === 'dismiss') {
        await deliverLive(event, true)
      }
    }
  }

  // Why: seed the watermark lazily so subscribe() doesn't block on an AsyncStorage read.
  let watermarkLoaded = false
  void loadLastSeenSeq(hostId).then((seq) => {
    lastDeliveredSeq = Math.max(lastDeliveredSeq, seq)
    watermarkLoaded = true
  })

  function unsubscribeServer(id: string) {
    if (client.getState() === 'connected') {
      client.sendRequest('notifications.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  let reconnectReadyCount = 0
  const unsubscribeStream = client.subscribe('notifications.subscribe', {}, (data: unknown) => {
    const event = data as
      | NotificationEvent
      | DismissNotificationEvent
      | SubscribeResult
      | { type: 'end' }
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      reconnectReadyCount += 1
      if (disposed) {
        unsubscribeServer(subscriptionId)
        unsubscribeStream()
        return
      }
      // Why: only reconnects fetch missed; watermarkLoaded guards against fetching from a stale 0 (which re-pushes everything).
      if (reconnectReadyCount > 1 && watermarkLoaded) {
        void fetchMissed()
      }
      return
    }
    if (event.type === 'end') {
      if (disposed) {
        unsubscribeStream()
      }
      return
    }
    if (disposed) {
      return
    }
    if (event.type === 'notification') {
      void deliverLive(event as NotificationEvent)
    } else if (event.type === 'dismiss') {
      void deliverLive(event as DismissNotificationEvent)
    }
  })

  return () => {
    disposed = true
    // Why: drop the local stream first — readiness can race unmount; don't hold the callback while a subscription id is pending.
    unsubscribeStream()
    if (subscriptionId) {
      unsubscribeServer(subscriptionId)
    }
  }
}
