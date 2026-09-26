import { ipcMain } from 'electron'
import { onSshFilesystemProviderRegistered } from '../providers/ssh-filesystem-dispatch'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import {
  cancelInFlightRemoteInstallIfUnowned,
  forgetDesiredRemoteWatcher,
  releaseRemoteWatchListener
} from './filesystem-watcher-listener-lifecycle'
import {
  installRemoteWatcher,
  reinstallRemoteWatchersForConnection,
  scheduleDormantRemoteWatcherRearm,
  scheduleRemoteWatcherRetry
} from './filesystem-watcher-remote-controller'
import { rememberDesiredRemoteWatcher } from './filesystem-watcher-remote-desired'
import {
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'

export function registerFilesystemWatcherHandlers(): void {
  // Why: re-registration replaces the handler set, so drop the previous subscription instead of
  // stacking a second re-arm on every provider registration.
  watcherLifecycleState.unsubscribeFromProviderRegistrations?.()
  watcherLifecycleState.unsubscribeFromProviderRegistrations = onSshFilesystemProviderRegistered(
    reinstallRemoteWatchersForConnection
  )

  ipcMain.handle(
    'fs:watchWorktree',
    async (event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        // Why: a real new watch reopens the subsystem after closeAllWatchers latched it shut (also resets tests between cases).
        watcherLifecycleState.remoteWatchersClosed = false
        const key = getRemoteWatcherKey(args.connectionId, args.worktreePath)
        // Why: record intent before the install so a provider registering mid-flight (or long after
        // this attempt gives up) can still re-arm this listener.
        rememberDesiredRemoteWatcher(args.connectionId, args.worktreePath, event.sender)
        const result = await installRemoteWatcher(
          event.sender,
          args.connectionId,
          args.worktreePath
        )
        if (result === 'capacity') {
          // Why straight to the dormant backoff: the cap is full until some other root is released,
          // which a 1 Hz reinstall cannot bring about — it only adds relay load per refused root.
          scheduleDormantRemoteWatcherRearm(args.connectionId, args.worktreePath)
          return
        }
        if (result === 'unavailable') {
          if (!watcherLifecycleState.loggedUnavailableRemoteWatchers.has(key)) {
            watcherLifecycleState.loggedUnavailableRemoteWatchers.add(key)
            console.warn(
              `[filesystem-watcher] SSH filesystem provider unavailable; retrying watch for ${args.worktreePath} on connection ${args.connectionId}`
            )
          }
          scheduleRemoteWatcherRetry(event.sender, args.connectionId, args.worktreePath)
          return
        }
        return
      }
      // Why: reopen the local subsystem for tests and post-shutdown reattachment; stale callers keep the prior generation.
      watcherLifecycleState.localWatchersClosed = false
      await subscribeLocalWatcher(args.worktreePath, event.sender)
    }
  )

  ipcMain.handle(
    'fs:unwatchWorktree',
    (_event, args: { worktreePath: string; connectionId?: string }): void => {
      if (args.connectionId) {
        const key = getRemoteWatcherKey(args.connectionId, args.worktreePath)
        // Why: the caller stopped watching on purpose — drop the intent or a later provider
        // registration would resurrect a watch nobody asked for.
        forgetDesiredRemoteWatcher(key, _event.sender.id)
        const suspended = watcherLifecycleState.suspendedRemoteWatcherListeners.get(key)
        suspended?.listeners.delete(_event.sender.id)
        if (suspended?.listeners.size === 0) {
          watcherLifecycleState.suspendedRemoteWatcherListeners.delete(key)
        }
        const retry = watcherLifecycleState.pendingRemoteWatcherRetryListeners.get(key)
        retry?.listeners.delete(_event.sender.id)
        const retryTimer = watcherLifecycleState.pendingRemoteWatcherRetries.get(key)
        if (retryTimer && retry?.listeners.size === 0) {
          clearTimeout(retryTimer)
          watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
          watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
        }
        // Why: a retry-tick provider.watch() may still be in flight; mark cancelled so its resolved unwatch handle is discarded.
        const inFlight = watcherLifecycleState.inFlightRemoteInstalls.get(key)
        if (inFlight) {
          inFlight.listeners.delete(_event.sender.id)
          cancelInFlightRemoteInstallIfUnowned(inFlight)
        }
        watcherLifecycleState.loggedUnavailableRemoteWatchers.delete(key)
        releaseRemoteWatchListener(key, _event?.sender?.id ?? 0)
        return
      }
      const senderId = _event.sender.id
      unsubscribeLocalWatcher(args.worktreePath, senderId)
    }
  )
}
