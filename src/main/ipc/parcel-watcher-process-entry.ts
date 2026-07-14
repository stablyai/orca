// Forked (ELECTRON_RUN_AS_NODE) child that hosts its assigned @parcel/watcher
// subscriptions. Why: watcher.node has native teardown races that fail-fast
// the hosting process (issue #7547, 0xc0000409 on Windows; same class as
// #5377/#6635). Running the native module here turns a watcher fault into a
// contained child crash the host can recover from, instead of killing the app
// and every agent session in it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ParcelWatcher from '@parcel/watcher'
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Canary self-check. Why: @parcel/watcher can wedge silently — a lock-order
// inversion between Debounce::notify (debounce mutex → watcher mutex) and
// Watcher teardown (watcher mutex → debounce mutex in ~Watcher) deadlocks the
// single process-wide debounce thread, after which every subscription still
// acks but no events are ever delivered. The canary watches a private temp
// dir and touches a file in it; consecutive missed deliveries mean event
// delivery is dead, so exit and let the host respawn a fresh process.
const CANARY_INTERVAL_MS = 10_000
const CANARY_EVENT_TIMEOUT_MS = 5_000
const CANARY_MAX_MISSES = 2

async function startCanary(getStableActivityRevision: () => number | null): Promise<void> {
  let canaryDir: string
  let lastEventAt = 0
  const configuredCanaryDir = process.env.ORCA_WATCHER_CANARY_DIR
  try {
    canaryDir = configuredCanaryDir ?? mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
    const watcher = await import('@parcel/watcher')
    // Why: pin the Windows backend like the main subscriptions do, so the
    // canary never probes for Watchman.
    const opts = (
      process.platform === 'win32' ? { backend: 'windows' } : {}
    ) as ParcelWatcher.Options
    await watcher.subscribe(
      canaryDir,
      (err) => {
        if (!err) {
          lastEventAt = Date.now()
        }
      },
      opts
    )
  } catch (err) {
    process.stderr.write(`[parcel-watcher-process] canary unavailable: ${errorMessage(err)}\n`)
    return
  }
  process.on('exit', () => {
    if (configuredCanaryDir) {
      return
    }
    try {
      rmSync(canaryDir, { recursive: true, force: true })
    } catch {
      // Temp dir cleanup is best-effort.
    }
  })

  let misses = 0
  setInterval(() => {
    // Why: Parcel holds its shared backend mutex throughout each initial tree
    // crawl, which legitimately starves canary delivery. Only apply the 5 s
    // event SLA after every requested subscription has finished crawling.
    const activityRevision = getStableActivityRevision()
    if (activityRevision === null) {
      misses = 0
      return
    }
    const probedAt = Date.now()
    try {
      writeFileSync(join(canaryDir, 'canary.txt'), String(probedAt))
    } catch {
      return
    }
    setTimeout(() => {
      // A root may start crawling after this probe was written. Invalidate the
      // probe instead of misclassifying lifecycle work as a delivery deadlock.
      if (getStableActivityRevision() !== activityRevision) {
        misses = 0
        return
      }
      if (lastEventAt >= probedAt) {
        misses = 0
        return
      }
      misses++
      if (misses >= CANARY_MAX_MISSES) {
        process.stderr.write(
          '[parcel-watcher-process] event delivery wedged (canary starved); restarting watcher process\n'
        )
        process.exit(2)
      }
    }, CANARY_EVENT_TIMEOUT_MS)
  }, CANARY_INTERVAL_MS)
}

function main(): void {
  const send = (message: WatcherToHostMessage): void => {
    try {
      process.send?.(message)
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
  const subscriptions = new Map<number, Promise<ParcelWatcher.AsyncSubscription | null>>()
  const liveSubscriptionIds = new Set<number>()
  const eventDeliveries = new Map<number, WatcherProcessEventDeliveryQueue>()
  let pendingSubscriptionCrawls = 0
  let activeSubscriptionCrawlId: number | null = null
  let subscriptionActivityRevision = 0
  let nativeLifecycleTail = Promise.resolve()

  const beginSubscriptionCrawl = (): void => {
    pendingSubscriptionCrawls++
    subscriptionActivityRevision++
  }

  const finishSubscriptionCrawl = (): void => {
    pendingSubscriptionCrawls--
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
  ): Promise<ParcelWatcher.AsyncSubscription | null> => {
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
          const watcher = await import('@parcel/watcher')
          return await watcher.subscribe(
            dir,
            (err, events) => {
              if (err) {
                send({ op: 'watch-error', id, message: errorMessage(err) })
                return
              }
              eventDelivery.enqueue(events)
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
      process.stderr.write(
        `[parcel-watcher-process] unsubscribe ${id} failed: ${errorMessage(err)}\n`
      )
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

  void startCanary(() => {
    if (pendingSubscriptionCrawls > 0 || liveSubscriptionIds.size === 0) {
      return null
    }
    return subscriptionActivityRevision
  })

  // Why: if the host dies (or kills us during shutdown), exit immediately —
  // process death releases every native watcher handle without running the
  // crash-prone napi teardown at all.
  process.on('disconnect', () => {
    process.exit(0)
  })
}

main()
