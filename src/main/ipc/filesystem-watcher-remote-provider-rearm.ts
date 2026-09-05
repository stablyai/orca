import type { WebContents } from 'electron'
import { isWatcherRemovalInProgressError } from './watcher-removal-gate'
import type {
  InstallRemoteWatcher,
  RequestRemoteWatcherResync
} from './filesystem-watcher-remote-retry'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { clearDormantRemoteWatcher } from './filesystem-watcher-listener-lifecycle'

type ScheduleRemoteWatcherRetry = (
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  startedAt?: number,
  resyncOnInstall?: boolean
) => void

/**
 * Rebuild remote watches for a connection whose filesystem provider was just (re)registered.
 *
 * Why: the relay's watch registrations die with the transport they were made on, and the previous
 * provider's unwatch handle is scoped to that dead transport. Reinstalling is the only way the
 * subscription comes back, and consumers get an overflow so they resync whatever changed while the
 * watch was down.
 */
export function reinstallRemoteWatchersForConnectionCore(
  connectionId: string,
  dependencies: {
    install: InstallRemoteWatcher
    requestResync: RequestRemoteWatcherResync
    scheduleRetry: ScheduleRemoteWatcherRetry
    scheduleDormant: (connectionId: string, worktreePath: string) => void
  }
): void {
  if (watcherLifecycleState.remoteWatchersClosed) {
    return
  }
  for (const [key, desired] of Array.from(watcherLifecycleState.desiredRemoteWatchers)) {
    if (desired.connectionId !== connectionId) {
      continue
    }
    for (const [senderId, sender] of Array.from(desired.listeners)) {
      if (sender.isDestroyed()) {
        desired.listeners.delete(senderId)
      }
    }
    if (desired.listeners.size === 0) {
      watcherLifecycleState.desiredRemoteWatchers.delete(key)
      continue
    }

    // Why: drop the entry the dead transport left behind first — installRemoteWatcher treats an
    // existing entry as already-installed and would hand back a watcher that can never fire again.
    const stale = watcherLifecycleState.remoteWatchers.get(key)
    if (stale) {
      watcherLifecycleState.remoteWatchers.delete(key)
      stale.batch.close()
      try {
        stale.unwatch()
      } catch {
        // Why: the handle belongs to the replaced transport; failing to close it is expected.
      }
    }
    const retryTimer = watcherLifecycleState.pendingRemoteWatcherRetries.get(key)
    if (retryTimer) {
      clearTimeout(retryTimer)
      watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
      watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
    }
    // Why: a pending watch belongs to the replaced transport; joiners must retry on the new provider.
    const inFlight = watcherLifecycleState.inFlightRemoteInstalls.get(key)
    if (inFlight) {
      inFlight.listeners.clear()
      inFlight.cancelled = true
      inFlight.abortController.abort()
    }
    // Why: this reinstall supersedes the pending backoff; leaving it armed double-installs the key.
    clearDormantRemoteWatcher(key)
    watcherLifecycleState.loggedUnavailableRemoteWatchers.delete(key)

    const listeners = Array.from(desired.listeners.values())
    void Promise.all(
      listeners.map((listener) =>
        dependencies.install(listener, desired.connectionId, desired.worktreePath)
      )
    )
      .then((results) => {
        // Why: events between the transport dropping and this reinstall are gone for good.
        dependencies.requestResync(
          key,
          desired.worktreePath,
          listeners.filter((_, index) => results[index] === 'installed')
        )
        if (results.some((result) => result === 'capacity')) {
          dependencies.scheduleDormant(desired.connectionId, desired.worktreePath)
          return
        }
        if (results.some((result) => result === 'unavailable')) {
          for (const listener of listeners) {
            dependencies.scheduleRetry(
              listener,
              desired.connectionId,
              desired.worktreePath,
              Date.now(),
              true
            )
          }
        }
      })
      .catch((error: unknown) => {
        if (isWatcherRemovalInProgressError(error)) {
          return
        }
        for (const listener of listeners) {
          dependencies.scheduleRetry(
            listener,
            desired.connectionId,
            desired.worktreePath,
            Date.now(),
            true
          )
        }
      })
  }
}
