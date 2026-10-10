import type { WebContents } from 'electron'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'
import { registerWatcherSenderCleanup } from './filesystem-watcher-listener-lifecycle'

export function rememberDesiredRemoteWatcher(
  connectionId: string,
  worktreePath: string,
  sender: WebContents
): void {
  if (sender.isDestroyed()) {
    return
  }
  const key = getRemoteWatcherKey(connectionId, worktreePath)
  const desired = watcherLifecycleState.desiredRemoteWatchers.get(key) ?? {
    connectionId,
    worktreePath,
    listeners: new Map<number, WebContents>()
  }
  desired.listeners.set(sender.id, sender)
  watcherLifecycleState.desiredRemoteWatchers.set(key, desired)
  registerWatcherSenderCleanup(sender)
}

export function isCurrentDesiredRemoteWatcher(key: string, listener: WebContents): boolean {
  return (
    watcherLifecycleState.desiredRemoteWatchers.get(key)?.listeners.get(listener.id) === listener
  )
}
