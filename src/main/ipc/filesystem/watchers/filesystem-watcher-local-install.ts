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
import type { WaitForLocalWatcherRetry } from './filesystem-watcher-local-capacity'
import {
  noteWslDistroMayHaveStopped,
  blockedWslDistroForPath
} from '../../../wsl/wsl-unc-access-gate'
import { deferUntilWslDistroRunning } from '../../../wsl-background-distro-gate'
import {
  clearWslRootStatRetry,
  nextWslRootStatRetry
} from './filesystem-watcher-wsl-root-stat-retry'

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
  scheduleRetry: (
    listeners: Map<number, Electron.WebContents>,
    waitForRetry?: WaitForLocalWatcherRetry
  ) => void
): Promise<LocalWatcherInstallResult> {
  const waitForDistro =
    (distro: string): WaitForLocalWatcherRetry =>
    (retry) =>
      deferUntilWslDistroRunning(distro, `fs-watch:${rootKey}`, () => void retry())
  let root: WatchedRoot
  try {
    // The stat and the watcher spawn would both boot a stopped distro; wait for it to run instead.
    const blocked = await blockedWslDistroForPath(worktreePath)
    if (blocked) {
      scheduleRetry(cancelToken.listeners, waitForDistro(blocked.distro))
      return 'capacity'
    }
    try {
      const s = await stat(rootPath)
      clearWslRootStatRetry(rootKey)
      if (!s.isDirectory()) {
        console.warn(`[filesystem-watcher] not a directory: ${rootKey}`)
        rememberUnwatchableRoot(rootKey)
        return 'unavailable'
      }
    } catch {
      // A distro just started may not serve its share yet: retry a few times before giving up.
      const retryWslRoot = isWslPath(worktreePath) ? nextWslRootStatRetry(rootKey) : null
      if (retryWslRoot) {
        scheduleRetry(cancelToken.listeners, retryWslRoot)
        return 'capacity'
      }
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
              watchedRoots: watcherLifecycleState.watchedRoots,
              onUnexpectedStop: (stoppedRoot, distro) => {
                noteWslDistroMayHaveStopped(distro)
                scheduleRetry(stoppedRoot.listeners, waitForDistro(distro))
              }
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
        scheduleRetry(cancelToken.listeners)
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
