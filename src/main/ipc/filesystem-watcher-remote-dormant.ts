import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWatcherRemovalInProgressError } from './watcher-removal-gate'
import type {
  InstallRemoteWatcher,
  RequestRemoteWatcherResync
} from './filesystem-watcher-remote-retry'
import {
  REMOTE_WATCH_DORMANT_RETRY_MAX_MS,
  REMOTE_WATCH_DORMANT_RETRY_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'

type ScheduleDormantDependencies = {
  install: InstallRemoteWatcher
  requestResync: RequestRemoteWatcherResync
}

export function scheduleDormantRemoteWatcherRearmCore(
  connectionId: string,
  worktreePath: string,
  dependencies: ScheduleDormantDependencies,
  delayMs = REMOTE_WATCH_DORMANT_RETRY_MS
): void {
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  if (
    watcherLifecycleState.remoteWatchersClosed ||
    !watcherLifecycleState.desiredRemoteWatchers.has(key) ||
    watcherLifecycleState.dormantRemoteWatchers.has(key)
  ) {
    return
  }
  const timer = setTimeout(() => {
    watcherLifecycleState.dormantRemoteWatchers.delete(key)
    void rearmDormantRemoteWatcher(key, connectionId, worktreePath, delayMs, dependencies)
  }, delayMs)
  // Why: a half-hour timer shouldn't be what keeps the process alive at quit.
  timer.unref?.()
  watcherLifecycleState.dormantRemoteWatchers.set(key, { delayMs, timer })
}

async function rearmDormantRemoteWatcher(
  key: string,
  connectionId: string,
  worktreePath: string,
  delayMs: number,
  dependencies: ScheduleDormantDependencies
): Promise<void> {
  const desired = watcherLifecycleState.desiredRemoteWatchers.get(key)
  if (watcherLifecycleState.remoteWatchersClosed || !desired) {
    return
  }
  for (const [senderId, sender] of Array.from(desired.listeners)) {
    if (sender.isDestroyed()) {
      desired.listeners.delete(senderId)
    }
  }
  if (desired.listeners.size === 0) {
    watcherLifecycleState.desiredRemoteWatchers.delete(key)
    return
  }
  // Why: a live watch or an in-flight fast retry already owns this key; installing again would
  // clobber the entry the running watch reads its listeners from.
  if (
    watcherLifecycleState.remoteWatchers.has(key) ||
    watcherLifecycleState.pendingRemoteWatcherRetries.has(key)
  ) {
    return
  }
  // Why: no provider means the connection itself is down, and its registration re-arms for free —
  // polling would only add wire traffic to a link that is already being rebuilt.
  if (!getSshFilesystemProvider(connectionId)) {
    return
  }

  const listeners = Array.from(desired.listeners.values())
  let results: Awaited<ReturnType<InstallRemoteWatcher>>[]
  try {
    results = await Promise.all(
      listeners.map((listener) => dependencies.install(listener, connectionId, worktreePath))
    )
  } catch (error) {
    if (isWatcherRemovalInProgressError(error)) {
      // Why: removal owns the key now and either forgets the intent or restores the watch itself.
      return
    }
    scheduleDormantRemoteWatcherRearmCore(
      connectionId,
      worktreePath,
      dependencies,
      nextDormantDelayMs(delayMs)
    )
    return
  }
  dependencies.requestResync(
    key,
    worktreePath,
    listeners.filter((_, index) => results[index] === 'installed')
  )
  // Why: 'cancelled' means shutdown or the last listener left, so only a refusal stays dormant.
  if (results.some((result) => result === 'unavailable' || result === 'capacity')) {
    scheduleDormantRemoteWatcherRearmCore(
      connectionId,
      worktreePath,
      dependencies,
      nextDormantDelayMs(delayMs)
    )
  }
}

function nextDormantDelayMs(delayMs: number): number {
  return Math.min(delayMs * 2, REMOTE_WATCH_DORMANT_RETRY_MAX_MS)
}
