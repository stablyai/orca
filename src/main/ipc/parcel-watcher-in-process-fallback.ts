import type * as ParcelWatcher from '@parcel/watcher'
import { createWatcherProcessEventDeliveryQueue } from './parcel-watcher-event-delivery'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'

/**
 * Use Parcel directly when Vitest mocks it. Production builds fail closed if
 * the crash-isolated child entry is unavailable.
 */
export async function subscribeWithInProcessWatcher(
  dir: string,
  callback: WatcherProcessCallback,
  opts: WatcherProcessSubscribeOptions,
  hooks: WatcherProcessHooks
): Promise<WatcherProcessSubscription> {
  if (hooks.signal?.aborted) {
    throw new WatcherProcessFailure(
      'file watcher subscription aborted',
      'subscription',
      'subscribe_aborted'
    )
  }
  let abortListener: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (hooks.signal) {
      abortListener = () =>
        reject(
          new WatcherProcessFailure(
            'file watcher subscription aborted',
            'subscription',
            'subscribe_aborted'
          )
        )
      hooks.signal.addEventListener('abort', abortListener, { once: true })
    }
    if (hooks.subscribeTimeoutMs !== undefined) {
      timer = setTimeout(() => {
        reject(
          new WatcherProcessFailure(
            `file watcher subscription timed out after ${hooks.subscribeTimeoutMs}ms`,
            'subscription',
            'subscribe_timeout'
          )
        )
      }, hooks.subscribeTimeoutMs)
      timer.unref?.()
    }
  })
  const clearPendingControls = (): void => {
    if (abortListener && hooks.signal) {
      hooks.signal.removeEventListener('abort', abortListener)
    }
    if (timer) {
      clearTimeout(timer)
    }
  }
  let watcher: typeof ParcelWatcher
  try {
    // Why: setup ownership starts before module loading; an abort or timeout
    // during the import must settle the caller just like one during the crawl.
    watcher = await Promise.race([import('@parcel/watcher'), cancellation])
  } catch (error) {
    clearPendingControls()
    throw error
  }
  let active = true
  const eventDelivery = createWatcherProcessEventDeliveryQueue(
    hooks.delivery,
    async (events) => {
      if (!active) {
        return
      }
      if (events === null) {
        hooks.onOverflow?.()
      } else {
        callback(null, events)
      }
    },
    (error) => callback(error instanceof Error ? error : new Error(String(error)), [])
  )
  const subscriptionPromise = watcher.subscribe(
    dir,
    (err, events) => {
      if (!active) {
        return
      }
      if (err) {
        callback(err, [])
        return
      }
      eventDelivery.enqueue(events)
    },
    opts as ParcelWatcher.Options
  )
  let subscription: ParcelWatcher.AsyncSubscription
  try {
    subscription = await Promise.race([subscriptionPromise, cancellation])
  } catch (error) {
    active = false
    eventDelivery.close()
    clearPendingControls()
    // Why: Parcel cannot cancel a crawl in-process. If it eventually finishes,
    // release the late native handle instead of leaking it into the test host.
    // Swallow unsubscribe failures so they never surface as unhandled rejections.
    void subscriptionPromise
      .then((lateSubscription) => lateSubscription.unsubscribe())
      .catch(() => undefined)
    throw error
  }
  clearPendingControls()
  return {
    unsubscribe: async (): Promise<void> => {
      active = false
      eventDelivery.close()
      await subscription.unsubscribe()
    }
  }
}
