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
  catchUpWatermarkSeq,
  enqueueHostDelivery,
  getHostNotificationSession,
  quarantineCatchUpWatermark,
  releaseQueuedShowNotificationId,
  resolveCatchUpQuarantine,
  saveWatermark,
  seedWatermarkFromStorage,
  seenKeyForEvent,
  shouldQueueShowForNotificationId
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

  /**
   * Queue one delivery on the host chain, dropping a show whose notificationId
   * already has one queued.
   *
   * Why the claim is taken HERE and not inside deliverLive (#8591): the point of
   * the dedup is to notice a second event arriving while the first is still
   * outstanding. Inside the queued task the first has already finished, so the
   * overlap is no longer observable — it has to be checked before enqueueing.
   */
  function queueDelivery(
    type: 'notification' | 'dismiss',
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    if (
      type === 'notification' &&
      !shouldQueueShowForNotificationId(session, event.notificationId)
    ) {
      return Promise.resolve()
    }
    return enqueueHostDelivery(session, async () => {
      try {
        await deliverLive(type, event)
      } finally {
        if (type === 'notification') {
          releaseQueuedShowNotificationId(session, event.notificationId)
        }
      }
      // Why swallowed: the caller is an un-awaited handler, so a rejected show would
      // surface as an unhandled rejection (a RN redbox) instead of being retried by
      // the next catch-up — which is now possible, since `seen` is marked after the show.
    }).catch(() => {})
  }

  async function deliverLive(
    type: 'notification' | 'dismiss',
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    adoptNotificationEpoch(session, hostId, event.notificationEpoch)
    const epochAtDelivery = session.lastDeliveredEpoch
    if (type === 'notification') {
      await showLocalNotification(event as NotificationEvent, hostId)
    } else {
      await dismissLocalNotification(event as DismissNotificationEvent, hostId)
    }
    // Why after the await, exactly like the watermark below: `seen` asserts this event
    // reached the user (#8129). Marked before, a rejected show leaves the key behind and
    // every later replay is dropped as a duplicate — loss the quarantine cannot recover,
    // since the first event to drain a batch lifts it past the one never shown.
    const key = seenKeyForEvent(event)
    // A mid-flight epoch adoption already cleared the counter lifetime this key indexes.
    if (key && session.lastDeliveredEpoch === epochAtDelivery) {
      session.seen.add(key)
    }
    // Why after the await (#8591): the watermark is a promise that everything up
    // to this seq has been shown. Advancing it before the local notification lands
    // means a process death in between silently drops it — the next launch asks the
    // desktop for seq greater than one the user never saw.
    if (event.notificationSeq != null && event.notificationSeq > session.lastDeliveredSeq) {
      session.lastDeliveredSeq = event.notificationSeq
      // Why clamped: while a failed catch-up's range is still unrecovered, persisting
      // the live seq would let the next catch-up ask from above the gap and the desktop
      // would cut it. resolveCatchUpQuarantine writes the held-back value on success.
      void saveWatermark(hostId, {
        seq: catchUpWatermarkSeq(session),
        epoch: session.lastDeliveredEpoch
      })
    }
  }

  // Claimed inline rather than via queueDelivery: the batch is already one queue
  // entry, and re-enqueueing per item is what let a live event cut in.
  async function deliverMissedEvent(
    event: NotificationEvent | DismissNotificationEvent
  ): Promise<void> {
    // No pre-marking here either: deliverLive marks the key once the show lands.
    const key = seenKeyForEvent(event)
    if (key && session.seen.has(key)) {
      return
    }
    if (event.type === 'notification') {
      if (!shouldQueueShowForNotificationId(session, event.notificationId)) {
        return
      }
      try {
        await deliverLive('notification', event)
      } finally {
        releaseQueuedShowNotificationId(session, event.notificationId)
      }
      return
    }
    if (event.type === 'dismiss') {
      await deliverLive('dismiss', event)
    }
  }

  // Why: desktop cuts by seq > lastSeenSeq, so re-fetching from the watermark is idempotent (session.seen guards residual overlap).
  async function fetchMissed(): Promise<void> {
    if (disposed) {
      return
    }
    // Captured before the request: everything at or below it is known delivered, so
    // it is the floor the watermark falls back to if this catch-up never completes.
    const askFrom = catchUpWatermarkSeq(session)
    const missed = await client
      .sendRequest('notifications.getMissedSince', {
        lastSeenSeq: askFrom,
        // Why: sending the epoch lets the desktop reject a watermark from a counter
        // it no longer has and return the whole retained buffer instead of nothing.
        ...(session.lastDeliveredEpoch != null ? { epoch: session.lastDeliveredEpoch } : {})
      })
      .then((response) => {
        if (!response.ok) {
          return null
        }
        const result = response.result as { notifications?: unknown[]; epoch?: string } | undefined
        adoptNotificationEpoch(session, hostId, result?.epoch)
        return Array.isArray(result?.notifications) ? result.notifications : []
      })
      .catch(() => null)
    if (missed == null) {
      // Why quarantine rather than retry: the range this catch-up abandoned stays
      // unrecovered until SOME later one succeeds, and a live seq persisting past it
      // meanwhile would make the desktop cut it forever.
      quarantineCatchUpWatermark(session, hostId, askFrom)
      return
    }
    // Why the whole batch is ONE queue entry (#8591): awaiting per event returns to
    // the event loop between replays, so a live seq 11 slots into the chain between
    // seq 6 and 7 and persists a watermark past a notification still unshown. Why the
    // request stays OUTSIDE the queue: sendRequest waits up to 30s, and holding the
    // chain for that would stall live delivery on a slow link.
    await enqueueHostDelivery(session, async () => {
      // Advances only past events this batch settled, so a teardown or a failing show
      // quarantines the true contiguous point instead of the range it never reached.
      let contiguousSeq = askFrom
      let drained = false
      try {
        for (const raw of missed) {
          // Re-checked per event: the batch can start before a teardown and still be
          // draining after it, and a torn-down host must stop pushing.
          if (disposed) {
            return
          }
          const event = raw as NotificationEvent | DismissNotificationEvent
          await deliverMissedEvent(event)
          contiguousSeq = event.notificationSeq ?? contiguousSeq
        }
        drained = true
      } finally {
        if (drained) {
          resolveCatchUpQuarantine(session, hostId)
        } else {
          quarantineCatchUpWatermark(session, hostId, contiguousSeq)
        }
      }
      // Why swallowed here: the `finally` above already recorded the contiguous point,
      // and the only caller is an un-awaited 'ready' continuation — letting a failed
      // show escape turns every one into an unhandled rejection (a RN redbox).
    }).catch(() => {})
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
      // Why the queue (#8591): a live event must not overtake an in-flight
      // catch-up replay, or it persists a watermark past seqs still unshown.
      await queueDelivery(
        liveEvent.type === 'notification' ? 'notification' : 'dismiss',
        liveEvent as NotificationEvent | DismissNotificationEvent
      )
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
