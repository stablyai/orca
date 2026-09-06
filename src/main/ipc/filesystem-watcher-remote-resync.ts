import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import {
  REMOTE_WATCH_RESYNC_COALESCE_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { isCurrentDesiredRemoteWatcher } from './filesystem-watcher-remote-desired'

function flushRemoteWatcherResync(key: string): void {
  const state = watcherLifecycleState.remoteWatcherResyncStates.get(key)
  if (!state) {
    return
  }
  state.timer = undefined
  if (
    watcherLifecycleState.remoteWatchersClosed ||
    watcherLifecycleState.suspendedRemoteWatcherListeners.has(key) ||
    !watcherLifecycleState.remoteWatchers.has(key)
  ) {
    if (!watcherLifecycleState.desiredRemoteWatchers.has(key)) {
      watcherLifecycleState.remoteWatcherResyncStates.delete(key)
    }
    return
  }
  let sent = false
  for (const listener of state.listeners.values()) {
    if (listener.isDestroyed() || !isCurrentDesiredRemoteWatcher(key, listener)) {
      continue
    }
    try {
      listener.send('fs:changed', {
        worktreePath: state.worktreePath,
        events: [{ kind: 'overflow', absolutePath: state.worktreePath }]
      } satisfies FsChangedPayload)
      sent = true
    } catch (error) {
      console.warn(`[filesystem-watcher] failed to send SSH watcher resync for ${key}:`, error)
    }
  }
  state.listeners.clear()
  if (sent) {
    state.lastSentAt = Date.now()
  } else {
    watcherLifecycleState.remoteWatcherResyncStates.delete(key)
  }
}

export function requestRemoteWatcherResync(
  key: string,
  worktreePath: string,
  listeners: Iterable<WebContents>
): void {
  const state = watcherLifecycleState.remoteWatcherResyncStates.get(key) ?? {
    lastSentAt: Number.NEGATIVE_INFINITY,
    listeners: new Map<number, WebContents>(),
    worktreePath
  }
  state.worktreePath = worktreePath
  for (const listener of listeners) {
    if (!listener.isDestroyed() && isCurrentDesiredRemoteWatcher(key, listener)) {
      state.listeners.set(listener.id, listener)
    }
  }
  if (state.listeners.size === 0) {
    return
  }
  watcherLifecycleState.remoteWatcherResyncStates.set(key, state)
  const delayMs = Math.max(0, state.lastSentAt + REMOTE_WATCH_RESYNC_COALESCE_MS - Date.now())
  if (delayMs === 0) {
    flushRemoteWatcherResync(key)
    return
  }
  if (!state.timer) {
    state.timer = setTimeout(() => flushRemoteWatcherResync(key), delayMs)
    state.timer.unref?.()
  }
}
