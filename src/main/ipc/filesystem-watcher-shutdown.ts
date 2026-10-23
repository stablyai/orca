import { disposeWatcherProcess } from './parcel-watcher-process'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { trackDetachedLocalUnsubscribe } from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

/** Tear down all watchers on app shutdown. */
export async function closeAllWatchers(): Promise<void> {
  for (const lifetime of watcherLifecycleState.senderLifetimes.values()) {
    lifetime.dispose()
  }
  watcherLifecycleState.senderLifetimes.clear()
  watcherLifecycleState.unwatchableRoots.clear()
  watcherLifecycleState.suspendedLocalWatcherListeners.clear()
  watcherLifecycleState.cancelledLocalInstallWaiters.clear()
  for (const retry of watcherLifecycleState.pendingLocalCapacityRetries.values()) {
    retry.cancelWait()
  }
  watcherLifecycleState.pendingLocalCapacityRetries.clear()

  // Cancel any pending grace-period teardowns — we're tearing down everything.
  for (const timer of watcherLifecycleState.pendingTeardowns.values()) {
    clearTimeout(timer)
  }
  watcherLifecycleState.pendingTeardowns.clear()

  // Why: latch the subsystem shut so late installs can't register; the generation bump rejects older-lifecycle waiters.
  watcherLifecycleState.localWatchersClosed = true
  watcherLifecycleState.localWatcherLifecycleGeneration += 1
  for (const token of watcherLifecycleState.inFlightLocalInstalls.values()) {
    token.listeners.clear()
    token.cancelled = true
    token.abortController.abort()
  }

  for (const [rootKey, root] of watcherLifecycleState.watchedRoots) {
    cancelLocalBatchFlush(root)
    await trackDetachedLocalUnsubscribe(rootKey, root).catch(() => undefined)
  }
  watcherLifecycleState.watchedRoots.clear()
  await Promise.allSettled(Array.from(watcherLifecycleState.pendingLocalUnsubscribes))
  watcherLifecycleState.failedLocalUnsubscribes.clear()
  // Why: kill the forked watcher process instead of watcher.node's crash-prone async teardown; process death frees native handles.
  disposeWatcherProcess()
}
