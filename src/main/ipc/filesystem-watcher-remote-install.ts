import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { isWatchRootCapacityRefusal } from '../../shared/watch-root-capacity-refusal'
import {
  WATCH_BATCH_MAX_WAIT_MS,
  WATCH_BATCH_TRAILING_MS
} from '../../shared/filesystem-watch-batch-window'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { MAX_BATCHED_WATCHER_EVENTS } from './filesystem-watcher-event-batch'
import { createRemoteWatcherEventBatch } from './remote-watcher-event-batch'
import { beginWatcherInstall } from './watcher-removal-gate'
import type {
  RemoteWatcherInstallResult,
  RemoteWatcherInstallToken
} from './filesystem-watcher-lifecycle-state'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import {
  addInFlightRemoteInstallListener,
  addRemoteWatchListener,
  registerWatcherSenderCleanup
} from './filesystem-watcher-listener-lifecycle'

export type RemoteWatcherTerminalErrorHandler = (
  key: string,
  connectionId: string,
  worktreePath: string,
  installToken: RemoteWatcherInstallToken,
  error: Error
) => void

export async function installRemoteWatcherCore(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  onTerminalError: RemoteWatcherTerminalErrorHandler,
  generation = watcherLifecycleState.remoteWatcherLifecycleGeneration
): Promise<RemoteWatcherInstallResult> {
  // Why: refuse installs racing in after teardown (or a waiter from an earlier lifecycle) so provider.watch() isn't called post-shutdown.
  if (
    watcherLifecycleState.remoteWatchersClosed ||
    generation !== watcherLifecycleState.remoteWatcherLifecycleGeneration
  ) {
    return 'cancelled'
  }
  const finishInstall = beginWatcherInstall(worktreePath, connectionId)
  try {
    return await installRemoteWatcherWhileRemovalAllowed(
      sender,
      connectionId,
      worktreePath,
      onTerminalError,
      generation
    )
  } finally {
    finishInstall()
  }
}

async function installRemoteWatcherWhileRemovalAllowed(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  onTerminalError: RemoteWatcherTerminalErrorHandler,
  generation: number
): Promise<RemoteWatcherInstallResult> {
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider || sender.isDestroyed()) {
    return 'unavailable'
  }

  const key = getRemoteWatcherKey(connectionId, worktreePath)
  const existing = watcherLifecycleState.remoteWatchers.get(key)
  if (existing) {
    addRemoteWatchListener(key, sender)
    return 'installed'
  }
  // Why: concurrent same-key watches must share the first provider.watch(); separate watchers would clobber per-key state and drop the unwatch handle.
  const pendingInstall = watcherLifecycleState.pendingRemoteInstallPromises.get(key)
  if (pendingInstall) {
    const inFlight = watcherLifecycleState.inFlightRemoteInstalls.get(key)
    const canJoinInstall = inFlight && !inFlight.abortController.signal.aborted
    if (canJoinInstall) {
      // Why: a new watcher joining before provider.watch() resolves should revive the install instead of inheriting the stale cancellation.
      addInFlightRemoteInstallListener(inFlight, sender)
    }
    const result = await pendingInstall
    if (
      result === 'installed' &&
      watcherLifecycleState.remoteWatchers.has(key) &&
      !sender.isDestroyed() &&
      (!inFlight || inFlight.listeners.has(sender.id))
    ) {
      addRemoteWatchListener(key, sender)
    }
    if (
      result === 'cancelled' &&
      !canJoinInstall &&
      !sender.isDestroyed() &&
      generation === watcherLifecycleState.remoteWatcherLifecycleGeneration
    ) {
      // Why: AbortSignal can't be revived; a listener arriving after cancellation waits out that generation, then owns a fresh install.
      if (watcherLifecycleState.pendingRemoteInstallPromises.get(key) === pendingInstall) {
        watcherLifecycleState.pendingRemoteInstallPromises.delete(key)
      }
      return installRemoteWatcherCore(
        sender,
        connectionId,
        worktreePath,
        onTerminalError,
        generation
      )
    }
    return result
  }
  const cancelToken: RemoteWatcherInstallToken = {
    cancelled: false,
    listeners: new Map(),
    abortController: new AbortController(),
    abortScheduled: false
  }
  watcherLifecycleState.inFlightRemoteInstalls.set(key, cancelToken)
  addInFlightRemoteInstallListener(cancelToken, sender)
  const installPromise = doInstallRemoteWatcher(
    provider,
    key,
    connectionId,
    worktreePath,
    cancelToken,
    onTerminalError
  )
  watcherLifecycleState.pendingRemoteInstallPromises.set(key, installPromise)
  try {
    return await installPromise
  } finally {
    if (watcherLifecycleState.pendingRemoteInstallPromises.get(key) === installPromise) {
      watcherLifecycleState.pendingRemoteInstallPromises.delete(key)
    }
  }
}

async function doInstallRemoteWatcher(
  provider: NonNullable<ReturnType<typeof getSshFilesystemProvider>>,
  key: string,
  connectionId: string,
  worktreePath: string,
  cancelToken: RemoteWatcherInstallToken,
  onTerminalError: RemoteWatcherTerminalErrorHandler
): Promise<RemoteWatcherInstallResult> {
  let unwatch: () => void
  // Why: the abandon paths below close the batch directly; once it is stored on the remoteWatchers
  // entry, every later teardown closes it through that handle. deliver's state/installToken guard
  // still covers a flush that races a close.
  const batch = createRemoteWatcherEventBatch({
    rootPath: worktreePath,
    trailingMs: WATCH_BATCH_TRAILING_MS,
    maxWaitMs: WATCH_BATCH_MAX_WAIT_MS,
    maxEvents: MAX_BATCHED_WATCHER_EVENTS,
    deliver: (events) => {
      const state = watcherLifecycleState.remoteWatchers.get(key)
      // Why: buffering defers delivery past install, so a bare non-null check would let a stale flush
      // land on a different install generation.
      if (!state || state.installToken !== cancelToken) {
        return
      }
      for (const listener of state.listeners.values()) {
        if (listener.isDestroyed()) {
          continue
        }
        try {
          listener.send('fs:changed', {
            worktreePath,
            events
          } satisfies FsChangedPayload)
        } catch (err) {
          // Why: batching moved this send out of the SSH mux's notification try/catch into a bare
          // timer, so a frame disposed mid-window would escape as a fatal main-process exception.
          console.warn(
            `[filesystem-watch] failed to deliver remote fs:changed for ${worktreePath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }
  })
  try {
    unwatch = await provider.watch(
      worktreePath,
      (events) => {
        batch.push(events)
      },
      {
        signal: cancelToken.abortController.signal,
        onTerminalError: (error) =>
          onTerminalError(key, connectionId, worktreePath, cancelToken, error)
      }
    )
  } catch (err) {
    // Why: the provider can fire its callback before rejecting (an aborted reinstall), so this
    // abandon path owes the same close as the two below — nothing else holds the batch.
    batch.close()
    if (cancelToken.cancelled || cancelToken.abortController.signal.aborted) {
      return 'cancelled'
    }
    if (isWatchRootCapacityRefusal(err)) {
      console.warn(`[filesystem-watcher] relay watch-root capacity reached for ${key}`)
      return 'capacity'
    }
    console.warn(`[filesystem-watcher] SSH watcher unavailable for ${key}:`, err)
    return 'unavailable'
  } finally {
    if (watcherLifecycleState.inFlightRemoteInstalls.get(key) === cancelToken) {
      watcherLifecycleState.inFlightRemoteInstalls.delete(key)
    }
  }
  const liveListeners = new Map(
    Array.from(cancelToken.listeners.entries()).filter(([, listener]) => !listener.isDestroyed())
  )
  if (cancelToken.cancelled || liveListeners.size === 0) {
    batch.close()
    try {
      unwatch()
    } catch (err) {
      console.error(`[filesystem-watcher] remote unwatch (post-cancel) error for ${key}:`, err)
    }
    return 'cancelled'
  }
  if (cancelToken.terminalError) {
    batch.close()
    return 'unavailable'
  }
  watcherLifecycleState.remoteWatchers.set(key, {
    unwatch,
    listeners: liveListeners,
    installToken: cancelToken,
    batch
  })
  for (const listener of liveListeners.values()) {
    registerWatcherSenderCleanup(listener)
  }
  watcherLifecycleState.loggedUnavailableRemoteWatchers.delete(key)
  return 'installed'
}
