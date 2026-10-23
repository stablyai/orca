// Forked (ELECTRON_RUN_AS_NODE) child that hosts its assigned @parcel/watcher
// subscriptions. Why: watcher.node has native teardown races that fail-fast
// the hosting process (issue #7547, 0xc0000409 on Windows; same class as
// #5377/#6635). Running the native module here turns a watcher fault into a
// contained child crash the host can recover from, instead of killing the app
// and every agent session in it.
import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './parcel-watcher-module-loader'
import { startShallowWatcher } from './parcel-watcher-shallow-subscription'
import { detectShallowWatchDelivery } from './shallow-watch-delivery-probe'
import { startWatcherDeliveryCanary } from './parcel-watcher-delivery-canary'
import {
  createWatcherProcessEventDeliveryQueue,
  type WatcherProcessEventDeliveryQueue
} from './parcel-watcher-event-delivery'
import type {
  HostToWatcherMessage,
  WatcherProcessDeliveryOptions,
  WatcherProcessSubscribeOptions,
  WatcherToHostMessage
} from './parcel-watcher-process-protocol'
import { errorMessage } from '../../shared/error-message'

type WatcherSubscription = {
  unsubscribe: () => Promise<void>
}

function main(): void {
  const send = (message: WatcherToHostMessage): void => {
    try {
      process.send?.(message, () => undefined)
    } catch {
      // Host is gone; the disconnect handler below exits this process.
    }
  }

  const sendEventWithBackpressure = (message: WatcherToHostMessage): Promise<void> => {
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      try {
        const accepted = process.send?.(message, finish)
        if (accepted !== false) {
          finish()
        }
      } catch {
        finish()
      }
    })
  }

  // Subscribe promises are kept (not just subscriptions) so an unsubscribe
  // that races a still-crawling subscribe awaits it instead of leaking the
  // native handle — on Windows a leaked handle keeps the worktree dir locked.
  const subscriptions = new Map<number, Promise<WatcherSubscription | null>>()
  const liveSubscriptionIds = new Set<number>()
  const eventDeliveries = new Map<number, WatcherProcessEventDeliveryQueue>()
  let pendingCrawlStartedAt: number | null = null
  let activeSubscriptionCrawlId: number | null = null
  let subscriptionActivityRevision = 0
  let lastNativeCallbackAt = 0
  let nativeLifecycleTail = Promise.resolve()

  // Native subscribes run one at a time under runNativeWatcherLifecycleExclusive.
  const beginSubscriptionCrawl = (): void => {
    pendingCrawlStartedAt = Date.now()
    subscriptionActivityRevision++
  }

  const finishSubscriptionCrawl = (): void => {
    pendingCrawlStartedAt = null
    subscriptionActivityRevision++
  }

  const runNativeWatcherLifecycleExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const ready = nativeLifecycleTail
    let release: () => void
    nativeLifecycleTail = new Promise((resolve) => {
      release = resolve
    })
    return ready.then(operation).finally(() => release())
  }

  const handleSubscribe = async (
    id: number,
    dir: string,
    opts: WatcherProcessSubscribeOptions,
    delivery: WatcherProcessDeliveryOptions | undefined
  ): Promise<WatcherSubscription | null> => {
    let rootDeleted = false
    const eventDelivery = createWatcherProcessEventDeliveryQueue(
      delivery,
      async (events) => {
        await sendEventWithBackpressure(
          events === null ? { op: 'overflow', id } : { op: 'events', id, events }
        )
      },
      (deliveryError) => {
        send({ op: 'watch-error', id, message: errorMessage(deliveryError) })
      }
    )
    eventDeliveries.set(id, eventDelivery)
    try {
      const subscription = await runNativeWatcherLifecycleExclusive(async () => {
        if (!subscriptions.has(id)) {
          return null
        }
        activeSubscriptionCrawlId = id
        beginSubscriptionCrawl()
        send({ op: 'subscribe-started', id })
        try {
          if (opts.mode === 'shallow') {
            // Why: registration succeeding proves nothing on a host whose
            // notification path is dead. Fail the subscribe so the caller falls
            // back to polling rather than going quietly stale.
            if (!(await detectShallowWatchDelivery())) {
              throw new Error('Shallow watcher delivery unavailable on this host')
            }
            return startShallowWatcher(dir, opts.include ?? [], eventDelivery.enqueue, (error) =>
              send({ op: 'watch-error', id, message: errorMessage(error) })
            )
          }
          const watcher = await loadParcelWatcher()
          return await watcher.subscribe(
            dir,
            (err, events) => {
              lastNativeCallbackAt = Date.now()
              if (rootDeleted) {
                return
              }
              if (err) {
                send({ op: 'watch-error', id, message: errorMessage(err) })
                return
              }
              rootDeleted = events.some((event) => event.type === 'delete' && event.path === dir)
              eventDelivery.enqueue(events)
              if (rootDeleted) {
                // Native backends stop deleted roots without reporting an error.
                void eventDelivery
                  .flush()
                  .then(() =>
                    send({ op: 'watch-error', id, message: 'File watcher root was deleted' })
                  )
              }
            },
            opts as ParcelWatcher.Options
          )
        } finally {
          activeSubscriptionCrawlId = null
          finishSubscriptionCrawl()
        }
      })
      // An unsubscribe can remove the record while subscribe() is crawling.
      // Only advertise it as live if it is still owned by this process.
      const stillOwned = subscriptions.has(id)
      if (stillOwned) {
        liveSubscriptionIds.add(id)
        send({ op: 'subscribed', id })
      }
      return subscription
    } catch (err) {
      const stillOwned = subscriptions.has(id)
      eventDelivery.close()
      eventDeliveries.delete(id)
      subscriptions.delete(id)
      liveSubscriptionIds.delete(id)
      if (stillOwned) {
        send({ op: 'subscribe-failed', id, message: errorMessage(err) })
      }
      return null
    }
  }

  const handleUnsubscribe = async (id: number): Promise<void> => {
    // Why: invalidate a probe already in flight, but keep future probes active.
    // A native teardown deadlock is the failure the canary exists to recover.
    subscriptionActivityRevision++
    const pending = subscriptions.get(id)
    subscriptions.delete(id)
    liveSubscriptionIds.delete(id)
    eventDeliveries.get(id)?.close()
    eventDeliveries.delete(id)
    try {
      // Why: Parcel already serializes crawl and teardown on one backend mutex.
      // Mirror that ordering here so neither operation can mask a canary miss.
      await runNativeWatcherLifecycleExclusive(async () => {
        const subscription = await pending
        await subscription?.unsubscribe()
      })
    } catch (err) {
      const message = errorMessage(err)
      process.stderr.write(`[parcel-watcher-process] unsubscribe ${id} failed: ${message}\n`)
      send({ op: 'unsubscribe-failed', id, message })
      return
    } finally {
      subscriptionActivityRevision++
    }
    send({ op: 'unsubscribed', id })
  }

  const handleCancelSubscribe = (id: number): void => {
    // Why: an in-flight native crawl cannot be cancelled safely; ask the host to
    // kill this child instead of risking the Parcel teardown deadlock.
    if (activeSubscriptionCrawlId === id) {
      subscriptions.delete(id)
      liveSubscriptionIds.delete(id)
      eventDeliveries.get(id)?.close()
      eventDeliveries.delete(id)
      send({ op: 'cancel-requires-restart', id })
      return
    }
    // Why: cancel can race a crawl that already finished. Reuse unsubscribe
    // teardown so a live native handle is released instead of leaked (Windows
    // keeps the worktree locked while the handle stays open).
    void handleUnsubscribe(id)
  }

  process.on('message', (message: HostToWatcherMessage) => {
    if (!message || typeof message !== 'object') {
      return
    }
    if (message.op === 'subscribe') {
      subscriptions.set(
        message.id,
        handleSubscribe(message.id, message.dir, message.opts, message.delivery)
      )
      return
    }
    if (message.op === 'unsubscribe') {
      void handleUnsubscribe(message.id)
      return
    }
    if (message.op === 'cancel-subscribe') {
      handleCancelSubscribe(message.id)
    }
  })

  void startWatcherDeliveryCanary(
    () => ({
      revision: subscriptionActivityRevision,
      liveSubscriptions: liveSubscriptionIds.size,
      pendingCrawlStartedAt,
      lastNativeCallbackAt
    }),
    (state) => send({ op: 'delivery-health', state })
  )

  // Why: if the host dies (or kills us during shutdown), exit immediately —
  // process death releases every native watcher handle without running the
  // crash-prone napi teardown at all.
  process.on('disconnect', () => {
    process.exit(0)
  })
}

main()
