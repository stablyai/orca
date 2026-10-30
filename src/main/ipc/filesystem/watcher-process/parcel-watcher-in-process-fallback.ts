import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './parcel-watcher-module-loader'
import {
  createWatcherProcessEventDeliveryQueue,
  isParcelWatcherRescanRequiredError
} from './parcel-watcher-event-delivery'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'

/** Vitest uses mocked Parcel directly; production fails closed when the child entry is missing. */
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
    // Abort/timeout owns setup before module loading as well as during crawling.
    watcher = await Promise.race([loadParcelWatcher(), cancellation])
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
        if (isParcelWatcherRescanRequiredError(err)) {
          eventDelivery.overflow()
          return
        }
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
    // In-process crawls cannot be cancelled; release late handles without unhandled teardown rejections.
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
