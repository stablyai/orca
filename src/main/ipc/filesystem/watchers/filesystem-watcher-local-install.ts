import { stat } from 'node:fs/promises'
import { isWslPath } from '../../../wsl'
import { WATCHER_IGNORE_DIRS } from './filesystem-watcher-ignore'
import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'
import { WatcherChildCapacityError } from '../watcher-process/parcel-watcher-child-registry'
import { isWatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'
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

function isCrashFuseFailure(error: unknown): boolean {
  return (
    isWatcherProcessFailure(error) &&
    (error.code === 'supervisor_crash_fuse' || error.code === 'process_unavailable')
  )
}

export async function installLocalWatcher(
  rootKey: string,
  rootPath: string,
  worktreePath: string,
  cancelToken: LocalWatcherInstallToken,
  scheduleCapacityRetry: (listeners: Map<number, Electron.WebContents>) => void
): Promise<LocalWatcherInstallResult> {
  let root: WatchedRoot
  try {
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
      // Run WSL snapshots inside the distro so shutdown kills them; native Windows uses Parcel.
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
      // Retain physical ownership if setup failed before the child proved exit.
      retainLocalWatcherPhysicalFailure(rootKey, error)
      if (cancelToken.cancelled) {
        if (isWatcherProcessFailure(error) && error.code === 'process_unavailable') {
          throw error
        }
        return 'cancelled'
      }
      // Capacity failures are retryable when a child exits, not permanently unwatchable roots.
      if (error instanceof WatcherChildCapacityError) {
        scheduleCapacityRetry(cancelToken.listeners)
        return 'capacity'
      }
      // Crash fuses can half-open after cooldown; do not permanently cache them.
      if (!isCrashFuseFailure(error)) {
        rememberUnwatchableRoot(rootKey)
      }
      return 'unavailable'
    }
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
