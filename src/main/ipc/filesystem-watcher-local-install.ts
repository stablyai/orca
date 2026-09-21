import { stat } from 'node:fs/promises'
import { isWslPath } from '../wsl'
import { WATCHER_IGNORE_DIRS } from './filesystem-watcher-ignore'
import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'
import { WatcherChildCapacityError } from './parcel-watcher-child-registry'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  LocalWatcherInstallResult,
  LocalWatcherInstallToken
} from './filesystem-watcher-lifecycle-state'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { createLocalWatcher, scheduleLocalBatchFlush } from './filesystem-watcher-local-events'
import {
  registerWatcherSenderCleanup,
  rememberUnwatchableRoot,
  retainLocalWatcherPhysicalFailure,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

export async function installLocalWatcher(
  rootKey: string,
  rootPath: string,
  worktreePath: string,
  cancelToken: LocalWatcherInstallToken,
  scheduleCapacityRetry: (listeners: Map<number, Electron.WebContents>) => void
): Promise<LocalWatcherInstallResult> {
  let root: WatchedRoot
  try {
    const s = await stat(rootPath)
    if (!s.isDirectory()) {
      console.warn(`[filesystem-watcher] not a directory: ${rootKey}`)
      rememberUnwatchableRoot(rootKey)
      return 'unavailable'
    }
  } catch {
    console.warn(`[filesystem-watcher] cannot stat root: ${rootKey}`)
    rememberUnwatchableRoot(rootKey)
    return 'unavailable'
  }

  try {
    // Why: WSL paths use one snapshot subprocess inside the distro so `wsl --shutdown` can kill it; native Windows uses @parcel/watcher.
    root = isWslPath(worktreePath)
      ? await createWslWatcher(
          rootKey,
          worktreePath,
          {
            ignoreDirs: WATCHER_IGNORE_DIRS,
            scheduleBatchFlush: scheduleLocalBatchFlush,
            watchedRoots: watcherLifecycleState.watchedRoots
          },
          cancelToken.abortController.signal
        )
      : await createLocalWatcher(rootKey, rootPath, cancelToken.abortController.signal)
  } catch (error) {
    // Why: setup can fail after its child misses the exit deadline; retain that owner even when the renderer-facing error is swallowed.
    retainLocalWatcherPhysicalFailure(rootKey, error)
    if (cancelToken.cancelled) {
      if (isWatcherProcessFailure(error) && error.code === 'process_unavailable') {
        throw error
      }
      return 'cancelled'
    }
    // Why: capacity is transient — allow retry once another child exits instead of caching this root as permanently failed.
    if (error instanceof WatcherChildCapacityError) {
      scheduleCapacityRetry(cancelToken.listeners)
      return 'capacity'
    }
    rememberUnwatchableRoot(rootKey)
    return 'unavailable'
  } finally {
    if (watcherLifecycleState.inFlightLocalInstalls.get(rootKey) === cancelToken) {
      watcherLifecycleState.inFlightLocalInstalls.delete(rootKey)
    }
  }

  const liveListeners = new Map(
    Array.from(cancelToken.listeners.entries()).filter(([, listener]) => !listener.isDestroyed())
  )
  if (cancelToken.cancelled || liveListeners.size === 0) {
    cancelLocalBatchFlush(root)
    void trackDetachedLocalUnsubscribe(rootKey, root)
    return 'cancelled'
  }

  root.listeners = liveListeners
  watcherLifecycleState.watchedRoots.set(rootKey, root)
  for (const listener of liveListeners.values()) {
    registerWatcherSenderCleanup(listener)
  }
  return 'installed'
}
