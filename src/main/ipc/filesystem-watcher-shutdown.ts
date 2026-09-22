import { disposeWatcherProcess } from './parcel-watcher-process'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { trackDetachedLocalUnsubscribe } from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

/** Tear down all watchers on app shutdown. */
export async function closeAllWatchers(): Promise<void> {
  // Why: drop the intent with the rest of the state, but keep the provider-registration
  // subscription — a new fs:watchWorktree reopens the subsystem and still needs the re-arm hook.
  watcherLifecycleState.desiredRemoteWatchers.clear()
  watcherLifecycleState.senderCleanupRegistered.clear()
  watcherLifecycleState.unwatchableRoots.clear()
  watcherLifecycleState.suspendedLocalWatcherListeners.clear()
  watcherLifecycleState.suspendedRemoteWatcherListeners.clear()
  for (const retry of watcherLifecycleState.pendingLocalCapacityRetries.values()) {
    retry.cancelWait()
  }
  watcherLifecycleState.pendingLocalCapacityRetries.clear()

  // Cancel any pending grace-period teardowns — we're tearing down everything.
  for (const timer of watcherLifecycleState.pendingTeardowns.values()) {
    clearTimeout(timer)
  }
  watcherLifecycleState.pendingTeardowns.clear()

  for (const timer of watcherLifecycleState.pendingRemoteWatcherRetries.values()) {
    clearTimeout(timer)
  }
  watcherLifecycleState.pendingRemoteWatcherRetries.clear()
  watcherLifecycleState.pendingRemoteWatcherRetryListeners.clear()
  for (const state of watcherLifecycleState.remoteWatcherResyncStates.values()) {
    if (state.timer) {
      clearTimeout(state.timer)
    }
  }
  watcherLifecycleState.remoteWatcherResyncStates.clear()
  for (const dormant of watcherLifecycleState.dormantRemoteWatchers.values()) {
    clearTimeout(dormant.timer)
  }
  watcherLifecycleState.dormantRemoteWatchers.clear()
  watcherLifecycleState.loggedUnavailableRemoteWatchers.clear()
  // Why: latch both subsystems shut so late installs can't register; generation bumps reject older-lifecycle waiters.
  watcherLifecycleState.remoteWatchersClosed = true
  watcherLifecycleState.remoteWatcherLifecycleGeneration += 1
  watcherLifecycleState.localWatchersClosed = true
  watcherLifecycleState.localWatcherLifecycleGeneration += 1
  watcherLifecycleState.pendingRemoteInstallPromises.clear()
  // Why: cancel in-flight provider.watch() calls so their resolved unwatch handles aren't installed post-shutdown.
  for (const token of watcherLifecycleState.inFlightRemoteInstalls.values()) {
    token.listeners.clear()
    token.cancelled = true
    token.abortController.abort()
  }
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

  // Why: remote watchers are separate from local @parcel/watcher subs; unwatch here or the relay keeps polling FS after shutdown.
  for (const [key, state] of watcherLifecycleState.remoteWatchers) {
    state.batch.close()
    try {
      state.unwatch()
    } catch (err) {
      console.error(`[filesystem-watcher] remote unwatch error for ${key}:`, err)
    }
  }
  watcherLifecycleState.remoteWatchers.clear()
}
