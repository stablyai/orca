import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import {
  clearDormantRemoteWatcher,
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
  for (const source of [
    watcherLifecycleState.pendingRemoteWatcherRetryListeners.get(key)?.listeners,
    watcherLifecycleState.inFlightRemoteInstalls.get(key)?.listeners,
    watcherLifecycleState.remoteWatchers.get(key)?.listeners
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
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
  watcherLifecycleState.suspendedRemoteWatcherListeners.delete(key)
  for (const sender of suspended.listeners.values()) {
    if (sender.isDestroyed()) {
      continue
    }
    const result = await installRemoteWatcher(sender, connectionId, worktreePath)
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
