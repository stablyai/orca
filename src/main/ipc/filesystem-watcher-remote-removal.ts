import { isCurrentWatcherSender } from './filesystem-watcher-sender-lifetime'
import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  watcherLifecycleState,
  type RemoteWatcherInstallResult
} from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import {
  clearDormantRemoteWatcher,
  registerWatcherSenderCleanup,
  clearRemoteWatcherResync
} from './filesystem-watcher-listener-lifecycle'
import {
  installRemoteWatcher,
  scheduleDormantRemoteWatcherRearm,
  scheduleRemoteWatcherRetry
} from './filesystem-watcher-remote-controller'

export async function closeRemoteWatcherForWorktreePath(
  connectionId: string,
  worktreePath: string
): Promise<void> {
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  const suspended = watcherLifecycleState.suspendedRemoteWatcherListeners.get(key) ?? {
    connectionId,
    worktreePath,
    listeners: new Map<number, WebContents>()
  }
  const waiters = watcherLifecycleState.cancelledRemoteInstallWaiters.get(key)
  for (const source of [
    watcherLifecycleState.pendingRemoteWatcherRetryListeners.get(key)?.listeners,
    watcherLifecycleState.inFlightRemoteInstalls.get(key)?.listeners,
    watcherLifecycleState.remoteWatchers.get(key)?.listeners,
    new Map(Array.from(waiters?.values() ?? [], ({ sender }) => [sender.id, sender]))
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
  // Why: a waiter's retry would install after this close; the restore re-subscribes it instead.
  watcherLifecycleState.cancelledRemoteInstallWaiters.delete(key)
  if (suspended.listeners.size > 0) {
    watcherLifecycleState.suspendedRemoteWatcherListeners.set(key, suspended)
  }
  clearRemoteWatcherResync(key)
  const retryTimer = watcherLifecycleState.pendingRemoteWatcherRetries.get(key)
  if (retryTimer) {
    clearTimeout(retryTimer)
    watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
    watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
  }
  // Why: removal is deliberate — a backoff firing mid-removal would re-watch the path being deleted.
  clearDormantRemoteWatcher(key)
  const inFlight = watcherLifecycleState.inFlightRemoteInstalls.get(key)
  if (inFlight) {
    inFlight.listeners.clear()
    inFlight.cancelled = true
  }
  const state = watcherLifecycleState.remoteWatchers.get(key)
  const provider = getSshFilesystemProvider(connectionId)
  await (provider?.closeWatch
    ? provider.closeWatch(worktreePath)
    : Promise.resolve(state?.unwatch()))
  state?.batch.close()
  watcherLifecycleState.remoteWatchers.delete(key)
  watcherLifecycleState.loggedUnavailableRemoteWatchers.delete(key)
}

export async function restoreRemoteWatcherAfterFailedRemoval(
  connectionId: string,
  worktreePath: string
): Promise<void> {
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  const suspended = watcherLifecycleState.suspendedRemoteWatcherListeners.get(key)
  if (!suspended) {
    return
  }
  const suspendedByKey = watcherLifecycleState.suspendedRemoteWatcherListeners
  const failures: {
    sender: WebContents
    signal: AbortSignal
    error: unknown
  }[] = []
  const owners = Array.from(suspended.listeners.values(), (sender) => ({
    sender,
    signal: registerWatcherSenderCleanup(sender)
  }))
  for (const { sender, signal } of owners) {
    // Why: a forgotten or replaced snapshot belongs to a newer removal; this restore must not consume it.
    if (suspendedByKey.get(key) !== suspended) {
      break
    }
    // Why: owners stay suspended until their turn, so an unwatch during an earlier owner's re-subscribe still withdraws them.
    // Why lifetime first: a reloaded window keeps its id, and its new entry is not this restore's to take.
    if (!isCurrentWatcherSender(sender, signal) || !suspended.listeners.delete(sender.id)) {
      continue
    }
    let result: RemoteWatcherInstallResult
    try {
      result = await installRemoteWatcher(sender, connectionId, worktreePath, undefined, signal)
    } catch (error) {
      if (isCurrentWatcherSender(sender, signal)) {
        failures.push({ sender, signal, error })
      }
      continue
    }
    if (!isCurrentWatcherSender(sender, signal)) {
      continue
    }
    if (result === 'capacity') {
      scheduleDormantRemoteWatcherRearm(connectionId, worktreePath)
    } else if (result === 'unavailable') {
      scheduleRemoteWatcherRetry(sender, connectionId, worktreePath)
    }
    sender.send('fs:changed', {
      worktreePath,
      events: [{ kind: 'overflow', absolutePath: worktreePath }]
    } satisfies FsChangedPayload)
  }
  // Why: an overlapping retried removal may have re-suspended owners into this same entry.
  if (suspendedByKey.get(key) === suspended && suspended.listeners.size === 0) {
    suspendedByKey.delete(key)
  }
  const liveFailures = failures.filter(({ sender, signal }) =>
    isCurrentWatcherSender(sender, signal)
  )
  if (liveFailures.length > 0) {
    const current = suspendedByKey.get(key) ?? {
      connectionId,
      worktreePath,
      listeners: new Map<number, WebContents>()
    }
    for (const { sender } of liveFailures) {
      current.listeners.set(sender.id, sender)
    }
    suspendedByKey.set(key, current)
    throw liveFailures[0].error
  }
}

export function forgetRemoteWatcherRemovalSnapshot(
  connectionId: string,
  worktreePath: string
): void {
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  watcherLifecycleState.suspendedRemoteWatcherListeners.delete(key)
  clearRemoteWatcherResync(key)
  const retryTimer = watcherLifecycleState.pendingRemoteWatcherRetries.get(key)
  if (retryTimer) {
    clearTimeout(retryTimer)
    watcherLifecycleState.pendingRemoteWatcherRetries.delete(key)
  }
  watcherLifecycleState.pendingRemoteWatcherRetryListeners.delete(key)
  // Why: the worktree is gone — keeping the intent lets a reconnect landing before the renderer's
  // unwatch re-watch a deleted path (60s of retries against the host, then a bogus overflow).
  watcherLifecycleState.desiredRemoteWatchers.delete(key)
  clearDormantRemoteWatcher(key)
}
