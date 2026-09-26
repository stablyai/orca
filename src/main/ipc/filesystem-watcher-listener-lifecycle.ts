import type { WebContents } from 'electron'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import {
  type LocalWatcherInstallToken,
  type RemoteWatcherInstallToken,
  UNWATCHABLE_ROOT_CACHE_MAX,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

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

export function cancelInFlightRemoteInstallIfUnowned(token: RemoteWatcherInstallToken): void {
  token.cancelled = token.listeners.size === 0
  if (!token.cancelled || token.abortScheduled || token.abortController.signal.aborted) {
    return
  }
  token.abortScheduled = true
  // Why: a replacement sender can synchronously revive the shared install during a renderer handoff; otherwise stop the relay crawl next microtask.
  queueMicrotask(() => {
    token.abortScheduled = false
    if (token.cancelled && token.listeners.size === 0) {
      token.abortController.abort()
    }
  })
}

export function addInFlightRemoteInstallListener(
  token: RemoteWatcherInstallToken,
  sender: WebContents
): void {
  if (sender.isDestroyed() || token.abortController.signal.aborted) {
    return
  }
  token.listeners.set(sender.id, sender)
  token.cancelled = false
  registerWatcherSenderCleanup(sender)
}

export function addRemoteWatchListener(key: string, sender: WebContents): void {
  const state = watcherLifecycleState.remoteWatchers.get(key)
  if (!state) {
    return
  }
  state.listeners.set(sender.id, sender)
  registerWatcherSenderCleanup(sender)
}

export function releaseRemoteWatchListener(key: string, senderId: number): void {
  const state = watcherLifecycleState.remoteWatchers.get(key)
  if (!state) {
    return
  }
  state.listeners.delete(senderId)
  if (state.listeners.size > 0) {
    return
  }
  state.unwatch()
  state.batch.close()
  watcherLifecycleState.remoteWatchers.delete(key)
}

export function registerWatcherSenderCleanup(sender: WebContents): void {
  if (watcherLifecycleState.senderCleanupRegistered.has(sender.id)) {
    return
  }
  watcherLifecycleState.senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => {
    watcherLifecycleState.senderCleanupRegistered.delete(sender.id)
    cleanupLocalWatchersForSender(sender.id)
    cleanupRemoteWatchersForSender(sender.id)
  })
}

function cleanupLocalWatchersForSender(senderId: number): void {
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

function cleanupRemoteWatchersForSender(senderId: number): void {
  for (const key of Array.from(watcherLifecycleState.desiredRemoteWatchers.keys())) {
    forgetDesiredRemoteWatcher(key, senderId)
  }
  for (const [key, suspended] of watcherLifecycleState.suspendedRemoteWatcherListeners) {
    suspended.listeners.delete(senderId)
    if (suspended.listeners.size === 0) {
      watcherLifecycleState.suspendedRemoteWatcherListeners.delete(key)
    }
  }
  for (const token of watcherLifecycleState.inFlightRemoteInstalls.values()) {
    token.listeners.delete(senderId)
    cancelInFlightRemoteInstallIfUnowned(token)
  }
  for (const [key, retry] of watcherLifecycleState.pendingRemoteWatcherRetryListeners) {
    retry.listeners.delete(senderId)
    if (retry.listeners.size === 0) {
      const timer = watcherLifecycleState.pendingRemoteWatcherRetries.get(key)
      if (timer) {
        clearTimeout(timer)
        watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
      }
      watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
    }
  }
  for (const key of Array.from(watcherLifecycleState.remoteWatchers.keys())) {
    releaseRemoteWatchListener(key, senderId)
  }
}

export function clearRemoteWatcherResync(key: string): void {
  const resync = watcherLifecycleState.remoteWatcherResyncStates.get(key)
  if (resync?.timer) {
    clearTimeout(resync.timer)
  }
  watcherLifecycleState.remoteWatcherResyncStates.delete(key)
}

export function clearDormantRemoteWatcher(key: string): void {
  const dormant = watcherLifecycleState.dormantRemoteWatchers.get(key)
  if (dormant) {
    clearTimeout(dormant.timer)
    watcherLifecycleState.dormantRemoteWatchers.delete(key)
  }
}

export function forgetDesiredRemoteWatcher(key: string, senderId: number): void {
  const desired = watcherLifecycleState.desiredRemoteWatchers.get(key)
  if (!desired) {
    return
  }
  desired.listeners.delete(senderId)
  if (desired.listeners.size === 0) {
    watcherLifecycleState.desiredRemoteWatchers.delete(key)
    clearRemoteWatcherResync(key)
    clearDormantRemoteWatcher(key)
  }
}
