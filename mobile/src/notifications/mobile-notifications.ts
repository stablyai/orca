import type { RpcClient } from '../transport/rpc-client'
// Re-exported so the existing importers (and their vi.mock paths) keep working.
export {
  ensureNotificationPermissions,
  getNotificationPermissionState,
  type NotificationPermissionState
} from './notification-permissions'
export { setScheduledNotificationsMaxForTests } from './local-notification-scheduling'
import {
  configureNotificationChannel,
  dismissLocalNotification,
  showLocalNotification,
  type DismissNotificationEvent,
  type NotificationEvent
} from './local-notification-scheduling'
import {
  adoptNotificationEpoch,
  getHostNotificationSession,
  saveWatermark,
  seedWatermarkFromStorage,
  seenKeyForEvent
} from './notification-reconnect-catchup'

type SubscribeResult = {
  type: 'ready'
  subscriptionId: string
  // Desktop counter lifetime (#8591); absent from runtimes that predate it.
  epoch?: string
}

// Per-connection subscription; a reconnect `ready` triggers watermarked catch-up (#8129) so already-pushed events aren't re-sent.
export function subscribeToDesktopNotifications(client: RpcClient, hostId: string): () => void {
  configureNotificationChannel()

  let subscriptionId: string | null = null
  let disposed = false
  // Why (#8591): survives the unsubscribe/resubscribe the app performs on every
  // socket drop, so a reconnect still knows its watermark and that it reconnected.
  const session = getHostNotificationSession(hostId)

  function deliverLive(
    type: 'notification' | 'dismiss',
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    adoptNotificationEpoch(session, hostId, event.notificationEpoch)
    if (event.notificationSeq != null && event.notificationSeq > session.lastDeliveredSeq) {
      session.lastDeliveredSeq = event.notificationSeq
      // Persisted as a pair: a seq is only trustworthy alongside the epoch it indexes.
      void saveWatermark(hostId, {
        seq: session.lastDeliveredSeq,
        epoch: session.lastDeliveredEpoch
      })
    }
    // Why (#8129): mark seen on the live path too, so a later replay of an already-pushed id dedups instead of double-pushing.
    const key = seenKeyForEvent(event)
    if (key) {
      session.seen.add(key)
    }
    if (type === 'notification') {
      return showLocalNotification(event as NotificationEvent, hostId)
    }
    return dismissLocalNotification(event as DismissNotificationEvent, hostId)
  }

  // Why: desktop cuts by seq > lastSeenSeq, so re-fetching from the watermark is idempotent (session.seen guards residual overlap).
  async function fetchMissed(): Promise<void> {
    if (disposed) {
      return
    }
    const missed = await client
      .sendRequest('notifications.getMissedSince', {
        lastSeenSeq: session.lastDeliveredSeq,
        // Why: sending the epoch lets the desktop reject a watermark from a counter
        // it no longer has and return the whole retained buffer instead of nothing.
        ...(session.lastDeliveredEpoch != null ? { epoch: session.lastDeliveredEpoch } : {})
      })
      .then((response) => {
        if (!response.ok) {
          return []
        }
        const result = response.result as { notifications?: unknown[]; epoch?: string } | undefined
        adoptNotificationEpoch(session, hostId, result?.epoch)
        return Array.isArray(result?.notifications) ? result.notifications : []
      })
      .catch(() => [])
    for (const raw of missed) {
      const event = raw as NotificationEvent | DismissNotificationEvent
      const key = seenKeyForEvent(event)
      if (key && session.seen.has(key)) {
        continue
      }
      if (key) {
        session.seen.add(key)
      }
      if (event.type === 'notification') {
        await deliverLive('notification', event)
      } else if (event.type === 'dismiss') {
        await deliverLive('dismiss', event)
      }
    }
  }

  seedWatermarkFromStorage(session, hostId)

  function unsubscribeServer(id: string) {
    if (client.getState() === 'connected') {
      client.sendRequest('notifications.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  const unsubscribeStream = client.subscribe('notifications.subscribe', {}, (data: unknown) => {
    const event = data as
      | NotificationEvent
      | DismissNotificationEvent
      | SubscribeResult
      | { type: 'end' }
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      const isReconnect = session.connectedBefore
      session.connectedBefore = true
      if (disposed) {
        unsubscribeServer(subscriptionId)
        unsubscribeStream()
        return
      }
      const readyEpoch = (event as SubscribeResult).epoch
      // Why (#8591) the await: on a cold app open the persisted read is still in
      // flight, so deciding here would see watermarkLoaded false and skip catch-up —
      // which is precisely the post-upgrade / post-process-death case that loses
      // every notification between the stored watermark and the next live seq.
      void (async () => {
        await session.watermarkSeeded
        if (disposed) {
          return
        }
        // Why before fetchMissed: adopting the epoch here is what voids a watermark
        // left over from a previous desktop lifetime, so the catch-up request carries
        // a watermark that means something against the counter now answering it.
        adoptNotificationEpoch(session, hostId, readyEpoch)
        // A reconnect always catches up. A cold open catches up only when this device
        // has delivered for this host before — a first-ever pairing must not be handed
        // the desktop's whole retained buffer.
        if (isReconnect || session.hadStoredWatermark) {
          await fetchMissed()
        }
      })()
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
    if (event.type !== 'notification' && event.type !== 'dismiss') {
      return
    }
    // Why the await (#8591): deliverLive advances the watermark. A live event landing
    // while the persisted read is still in flight would push it past the buffered seqs
    // the catch-up is about to ask for, and getMissedSince would cut them. Ordering is
    // preserved — every handler waits on the same promise, and the 'ready' continuation
    // registered on it first, so catch-up still builds its request before any live seq.
    const liveEvent = event
    void (async () => {
      await session.watermarkSeeded
      if (disposed) {
        return
      }
      if (liveEvent.type === 'notification') {
        await deliverLive('notification', liveEvent as NotificationEvent)
      } else {
        await deliverLive('dismiss', liveEvent as DismissNotificationEvent)
      }
    })()
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
