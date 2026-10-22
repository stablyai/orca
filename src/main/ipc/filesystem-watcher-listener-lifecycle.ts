import type { WebContents } from 'electron'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import {
  type CancelledInstallWaiter,
  type CancelledInstallWaiters,
  type LocalWatcherInstallToken,
  UNWATCHABLE_ROOT_CACHE_MAX,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { captureWatcherSenderLifetime } from './filesystem-watcher-sender-lifetime'

export function rememberUnwatchableRoot(rootKey: string): void {
  const { unwatchableRoots } = watcherLifecycleState
  // Why: deleted worktrees churn through unique paths; cap the set so retry suppression stays useful without retaining every failed path.
  unwatchableRoots.delete(rootKey)
  unwatchableRoots.add(rootKey)
  while (unwatchableRoots.size > UNWATCHABLE_ROOT_CACHE_MAX) {
    const oldest = unwatchableRoots.keys().next().value
    if (oldest === undefined) {
      break
    }
    unwatchableRoots.delete(oldest)
  }
}

export function retainLocalWatcherPhysicalFailure(rootKey: string, error: unknown): void {
  if (!isWatcherProcessFailure(error) || !error.physicalExit) {
    return
  }
  watcherLifecycleState.failedLocalUnsubscribes.set(rootKey, error)
  void error.physicalExit.then(() => {
    if (watcherLifecycleState.failedLocalUnsubscribes.get(rootKey) === error) {
      watcherLifecycleState.failedLocalUnsubscribes.delete(rootKey)
    }
  })
}

export function trackDetachedLocalUnsubscribe(rootKey: string, root: WatchedRoot): Promise<void> {
  const rootUnsubscribes =
    watcherLifecycleState.pendingLocalUnsubscribesByRoot.get(rootKey) ?? new Set<Promise<void>>()
  watcherLifecycleState.pendingLocalUnsubscribesByRoot.set(rootKey, rootUnsubscribes)
  const unsubscribePromise = Promise.resolve()
    .then(() => root.subscription.unsubscribe())
    .finally(() => {
      watcherLifecycleState.pendingLocalUnsubscribes.delete(unsubscribePromise)
      rootUnsubscribes.delete(unsubscribePromise)
      if (rootUnsubscribes.size === 0) {
        watcherLifecycleState.pendingLocalUnsubscribesByRoot.delete(rootKey)
      }
    })
  watcherLifecycleState.pendingLocalUnsubscribes.add(unsubscribePromise)
  rootUnsubscribes.add(unsubscribePromise)
  // Why: swallow here to avoid unhandled rejections, but keep the original promise rejected so later destructive cleanup can fail closed.
  void unsubscribePromise.catch((error: unknown) => {
    if (!watcherLifecycleState.abandonedLocalUnsubscribes.has(unsubscribePromise)) {
      retainLocalWatcherPhysicalFailure(rootKey, error)
    }
    console.error(`[filesystem-watcher] unsubscribe error for ${rootKey}:`, error)
  })
  return unsubscribePromise
}

/** Mark unsubscribes whose drain timed out so their late failures stay out of failedLocalUnsubscribes. */
export function abandonLocalUnsubscribes(promises: Iterable<Promise<void>>): void {
  for (const promise of promises) {
    watcherLifecycleState.abandonedLocalUnsubscribes.add(promise)
  }
}

export function addInFlightLocalInstallListener(
  token: LocalWatcherInstallToken,
  sender: WebContents
): void {
  if (sender.isDestroyed() || token.abortController.signal.aborted) {
    return
  }
  token.listeners.set(sender.id, sender)
  token.cancelled = false
  registerWatcherSenderCleanup(sender)
}

function cleanupInFlightLocalInstallsForSender(senderId: number): void {
  for (const token of watcherLifecycleState.inFlightLocalInstalls.values()) {
    token.listeners.delete(senderId)
    if (token.listeners.size === 0) {
      token.cancelled = true
      // Why: abort so a pending native/forked subscription stops early (matches closeLocalWatcherForWorktreePath / closeAllWatchers).
      token.abortController.abort()
    }
  }
  for (const [rootKey, retry] of watcherLifecycleState.pendingLocalCapacityRetries) {
    retry.listeners.delete(senderId)
    if (retry.listeners.size === 0) {
      retry.cancelWait()
      watcherLifecycleState.pendingLocalCapacityRetries.delete(rootKey)
    }
  }
}

export function takeLocalCapacityRetryListeners(rootKey: string): WebContents[] {
  const retry = watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)
  if (!retry) {
    return []
  }
  retry.cancelWait()
  watcherLifecycleState.pendingLocalCapacityRetries.delete(rootKey)
  return [...retry.listeners.values()].filter((listener) => !listener.isDestroyed())
}

export function clearLocalCapacityRetry(rootKey: string): void {
  const retry = watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)
  retry?.cancelWait()
  watcherLifecycleState.pendingLocalCapacityRetries.delete(rootKey)
}

export function addLocalWatchListener(rootKey: string, sender: WebContents): void {
  const root = watcherLifecycleState.watchedRoots.get(rootKey)
  if (!root || sender.isDestroyed()) {
    return
  }
  root.listeners.set(sender.id, sender)
  registerWatcherSenderCleanup(sender)
}

export function addCancelledInstallWaiter(
  waitersByKey: CancelledInstallWaiters,
  key: string,
  sender: WebContents
): symbol {
  const token = Symbol('cancelled-install-wait')
  const waiters = waitersByKey.get(key) ?? new Map<number, CancelledInstallWaiter>()
  waiters.set(sender.id, { token, sender })
  waitersByKey.set(key, waiters)
  return token
}

/** Removes the waiter and reports whether it was still `token`'s, i.e. not withdrawn meanwhile. */
export function takeCancelledInstallWaiter(
  waitersByKey: CancelledInstallWaiters,
  key: string,
  senderId: number,
  token: symbol
): boolean {
  if (waitersByKey.get(key)?.get(senderId)?.token !== token) {
    return false
  }
  forgetCancelledInstallWaiter(waitersByKey, key, senderId)
  return true
}

export function forgetCancelledInstallWaiter(
  waitersByKey: CancelledInstallWaiters,
  key: string,
  senderId: number
): void {
  const waiters = waitersByKey.get(key)
  waiters?.delete(senderId)
  if (waiters?.size === 0) {
    waitersByKey.delete(key)
  }
}

export function registerWatcherSenderCleanup(sender: WebContents): AbortSignal {
  return captureWatcherSenderLifetime(sender, () => {
    cleanupLocalWatchersForSender(sender.id)
  })
}

function cleanupLocalWatchersForSender(senderId: number): void {
  for (const key of Array.from(watcherLifecycleState.cancelledLocalInstallWaiters.keys())) {
    forgetCancelledInstallWaiter(watcherLifecycleState.cancelledLocalInstallWaiters, key, senderId)
  }
  for (const [rootKey, suspended] of watcherLifecycleState.suspendedLocalWatcherListeners) {
    suspended.listeners.delete(senderId)
    if (suspended.listeners.size === 0) {
      watcherLifecycleState.suspendedLocalWatcherListeners.delete(rootKey)
    }
  }
  cleanupInFlightLocalInstallsForSender(senderId)
  for (const [key, watchedRoot] of watcherLifecycleState.watchedRoots) {
    if (!watchedRoot.listeners.has(senderId)) {
      continue
    }
    watchedRoot.listeners.delete(senderId)
    if (watchedRoot.listeners.size === 0) {
      // Cancel any pending grace-period teardown for this root.
      const pending = watcherLifecycleState.pendingTeardowns.get(key)
      if (pending) {
        clearTimeout(pending)
        watcherLifecycleState.pendingTeardowns.delete(key)
      }
      cancelLocalBatchFlush(watchedRoot)
      trackDetachedLocalUnsubscribe(key, watchedRoot)
      watcherLifecycleState.watchedRoots.delete(key)
    }
  }
}
