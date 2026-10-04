import { isCurrentWatcherSender } from './filesystem-watcher-sender-lifetime'
import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { isWatcherRemovalInProgressError } from './watcher-removal-gate'
import type { RemoteWatcherInstallResult } from './filesystem-watcher-lifecycle-state'
import {
  REMOTE_WATCH_RETRY_MS,
  REMOTE_WATCH_RETRY_TIMEOUT_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import {
  clearRemoteWatcherResync,
  registerWatcherSenderCleanup
} from './filesystem-watcher-listener-lifecycle'
import { isCurrentDesiredRemoteWatcher } from './filesystem-watcher-remote-desired'

export type InstallRemoteWatcher = (
  sender: WebContents,
  connectionId: string,
  worktreePath: string
) => Promise<RemoteWatcherInstallResult>

export type RequestRemoteWatcherResync = (
  key: string,
  worktreePath: string,
  listeners: Iterable<WebContents>
) => void

type ScheduleDormantRemoteWatcher = (
  connectionId: string,
  worktreePath: string,
  delayMs?: number
) => void

export function scheduleRemoteWatcherRetryCore(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  dependencies: {
    install: InstallRemoteWatcher
    requestResync: RequestRemoteWatcherResync
    scheduleDormant: ScheduleDormantRemoteWatcher
  },
  startedAt = Date.now(),
  // Why: a retry that replaces a watch which was already live owes the renderer an overflow once it
  // lands — the events lost while it was down are otherwise never signalled.
  resyncOnInstall = false
): void {
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  if (watcherLifecycleState.remoteWatchersClosed || !isCurrentDesiredRemoteWatcher(key, sender)) {
    return
  }
  const existingRetry = watcherLifecycleState.pendingRemoteWatcherRetryListeners.get(key)
  if (existingRetry) {
    if (!sender.isDestroyed()) {
      existingRetry.listeners.set(sender.id, sender)
    }
    existingRetry.resyncOnInstall ||= resyncOnInstall
    return
  }

  const retry = {
    listeners: new Map(sender.isDestroyed() ? [] : [[sender.id, sender]]),
    startedAt,
    resyncOnInstall
  }
  watcherLifecycleState.pendingRemoteWatcherRetryListeners.set(key, retry)

  if (Date.now() - startedAt >= REMOTE_WATCH_RETRY_TIMEOUT_MS || sender.isDestroyed()) {
    watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
    watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
    watcherLifecycleState.loggedUnavailableRemoteWatchers.delete(key)
    clearRemoteWatcherResync(key)
    // Why: handler already resolved so the renderer thinks the watch is live; emit overflow to force a manual refresh instead of waiting forever.
    for (const listener of retry.listeners.values()) {
      if (listener.isDestroyed() || !isCurrentDesiredRemoteWatcher(key, listener)) {
        continue
      }
      console.warn(
        `[filesystem-watcher] giving up SSH watch retry for ${worktreePath} on connection ${connectionId} after ${REMOTE_WATCH_RETRY_TIMEOUT_MS}ms`
      )
      listener.send('fs:changed', {
        worktreePath,
        events: [{ kind: 'overflow', absolutePath: worktreePath }]
      } satisfies FsChangedPayload)
    }
    // Why: overflow only refreshes once — without this the watch stays dead until the app restarts.
    dependencies.scheduleDormant(connectionId, worktreePath)
    return
  }

  const retryTimer = setTimeout(() => {
    watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
    watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
    const listeners = Array.from(retry.listeners.values()).filter(
      (listener) => !listener.isDestroyed() && isCurrentDesiredRemoteWatcher(key, listener)
    )
    const signals = listeners.map(registerWatcherSenderCleanup)
    const liveListeners = () =>
      listeners.filter((listener, index) => isCurrentWatcherSender(listener, signals[index]))
    void Promise.all(
      listeners.map((listener) => dependencies.install(listener, connectionId, worktreePath))
    )
      .then((results) => {
        if (liveListeners().length === 0) {
          return
        }
        if (retry.resyncOnInstall) {
          dependencies.requestResync(
            key,
            worktreePath,
            listeners.filter(
              (listener, index) =>
                results[index] === 'installed' && isCurrentWatcherSender(listener, signals[index])
            )
          )
        }
        // Why capacity leaves the fast window: the relay is refusing on a full watch-root cap, and a
        // 1 Hz reinstall per refused root is exactly the load that keeps the cap busy (#11196).
        if (results.some((result) => result === 'capacity')) {
          dependencies.scheduleDormant(connectionId, worktreePath)
          return
        }
        // Why: don't re-arm on 'cancelled' (renderer stopped watching) — it would fire a stale overflow when the 60s window expires.
        if (results.some((result) => result === 'unavailable')) {
          for (const listener of liveListeners()) {
            scheduleRemoteWatcherRetryCore(
              listener,
              connectionId,
              worktreePath,
              dependencies,
              retry.startedAt,
              retry.resyncOnInstall
            )
          }
        }
      })
      .catch((error: unknown) => {
        if (isWatcherRemovalInProgressError(error)) {
          return
        }
        for (const listener of liveListeners()) {
          scheduleRemoteWatcherRetryCore(
            listener,
            connectionId,
            worktreePath,
            dependencies,
            retry.startedAt,
            retry.resyncOnInstall
          )
        }
      })
  }, REMOTE_WATCH_RETRY_MS)
  watcherLifecycleState.pendingRemoteWatcherRetries.set(key, retryTimer)
}
