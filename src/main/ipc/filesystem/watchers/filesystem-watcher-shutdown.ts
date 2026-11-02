import { disposeWatcherProcess } from '../watcher-process/parcel-watcher-process'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { trackDetachedLocalUnsubscribe } from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

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

  for (const timer of watcherLifecycleState.pendingTeardowns.values()) {
    clearTimeout(timer)
  }
  watcherLifecycleState.pendingTeardowns.clear()

  // Close and bump generation before late installs or waiters can revive retired state.
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
  // Process exit frees native handles without crash-prone watcher.node async teardown.
  disposeWatcherProcess()
}
