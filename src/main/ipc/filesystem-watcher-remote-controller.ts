import type { WebContents } from 'electron'
import type { RemoteWatcherInstallToken } from './filesystem-watcher-lifecycle-state'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  installRemoteWatcherCore,
  type RemoteWatcherTerminalErrorHandler
} from './filesystem-watcher-remote-install'
import { requestRemoteWatcherResync } from './filesystem-watcher-remote-resync'
import { scheduleRemoteWatcherRetryCore } from './filesystem-watcher-remote-retry'
import { scheduleDormantRemoteWatcherRearmCore } from './filesystem-watcher-remote-dormant'
import { reinstallRemoteWatchersForConnectionCore } from './filesystem-watcher-remote-provider-rearm'

export function installRemoteWatcher(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  generation = watcherLifecycleState.remoteWatcherLifecycleGeneration
) {
  return installRemoteWatcherCore(
    sender,
    connectionId,
    worktreePath,
    handleRemoteWatcherTerminalError,
    generation
  )
}

export function scheduleRemoteWatcherRetry(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  startedAt = Date.now(),
  resyncOnInstall = false
): void {
  scheduleRemoteWatcherRetryCore(
    sender,
    connectionId,
    worktreePath,
    {
      install: installRemoteWatcher,
      requestResync: requestRemoteWatcherResync,
      scheduleDormant: scheduleDormantRemoteWatcherRearm
    },
    startedAt,
    resyncOnInstall
  )
}

export function scheduleDormantRemoteWatcherRearm(
  connectionId: string,
  worktreePath: string,
  delayMs?: number
): void {
  scheduleDormantRemoteWatcherRearmCore(
    connectionId,
    worktreePath,
    { install: installRemoteWatcher, requestResync: requestRemoteWatcherResync },
    delayMs
  )
}

export function reinstallRemoteWatchersForConnection(connectionId: string): void {
  reinstallRemoteWatchersForConnectionCore(connectionId, {
    install: installRemoteWatcher,
    requestResync: requestRemoteWatcherResync,
    scheduleRetry: scheduleRemoteWatcherRetry,
    scheduleDormant: scheduleDormantRemoteWatcherRearm
  })
}

const handleRemoteWatcherTerminalError: RemoteWatcherTerminalErrorHandler = (
  key: string,
  connectionId: string,
  worktreePath: string,
  installToken: RemoteWatcherInstallToken,
  error: Error
): void => {
  installToken.terminalError = error
  const state = watcherLifecycleState.remoteWatchers.get(key)
  if (!state || state.installToken !== installToken) {
    return
  }
  watcherLifecycleState.remoteWatchers.delete(key)
  state.batch.close()
  if (
    watcherLifecycleState.remoteWatchersClosed ||
    watcherLifecycleState.suspendedRemoteWatcherListeners.has(key)
  ) {
    return
  }
  console.warn(`[filesystem-watcher] SSH watcher terminated for ${key}:`, error)
  const startedAt = Date.now()
  for (const listener of state.listeners.values()) {
    scheduleRemoteWatcherRetry(listener, connectionId, worktreePath, startedAt, true)
  }
}
