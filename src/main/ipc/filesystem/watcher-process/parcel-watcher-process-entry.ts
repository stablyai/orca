// Isolate native watcher teardown crashes so they cannot kill the app and its agent sessions (#7547).
import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './parcel-watcher-module-loader'
import { startShallowWatcher } from './parcel-watcher-shallow-subscription'
import { detectShallowWatchDelivery } from '../../shallow-watch-delivery-probe'
import { startWatcherDeliveryCanary } from '../../parcel-watcher-delivery-canary'
import {
  createWatcherProcessEventDeliveryQueue,
  isParcelWatcherRescanRequiredError,
  type WatcherProcessEventDeliveryQueue
} from './parcel-watcher-event-delivery'
import type {
  HostToWatcherMessage,
  WatcherProcessDeliveryOptions,
  WatcherProcessSubscribeOptions,
  WatcherToHostMessage
} from './parcel-watcher-process-protocol'
import { errorMessage } from '../../../../shared/error-message'

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

  // Keep pending subscribes so racing unsubscribe waits for the handle and releases Windows directory locks.
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
            // Successful registration does not prove delivery; fail so callers can poll.
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
              if (err && !isParcelWatcherRescanRequiredError(err)) {
                send({ op: 'watch-error', id, message: errorMessage(err) })
                return
              }
              rootDeleted = events.some((event) => event.type === 'delete' && event.path === dir)
              if (err) {
                eventDelivery.overflow()
              } else {
                eventDelivery.enqueue(events)
              }
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
      // Unsubscribe may have removed ownership while subscribe was crawling.
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
    // Invalidate this probe, but keep future probes armed to catch teardown deadlocks.
    subscriptionActivityRevision++
    const pending = subscriptions.get(id)
    subscriptions.delete(id)
    liveSubscriptionIds.delete(id)
    eventDeliveries.get(id)?.close()
    eventDeliveries.delete(id)
    try {
      // Mirror Parcel's crawl/teardown mutex ordering so neither masks a canary miss.
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
    // In-flight native crawls cannot be cancelled safely; have the host kill this child.
    if (activeSubscriptionCrawlId === id) {
      subscriptions.delete(id)
      liveSubscriptionIds.delete(id)
      eventDeliveries.get(id)?.close()
      eventDeliveries.delete(id)
      send({ op: 'cancel-requires-restart', id })
      return
    }
    // A completed crawl still owns a handle; reuse unsubscribe to release it and any Windows directory lock.
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

  // Process death releases watcher handles without crash-prone native teardown.
  process.on('disconnect', () => {
    process.exit(0)
  })
}

main()
