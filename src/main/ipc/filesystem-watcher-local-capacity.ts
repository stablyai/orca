import type { WebContents } from 'electron'
import { onWatcherChildCapacityAvailable } from './parcel-watcher-child-registry'
import type { LocalWatcherCapacityRetry } from './filesystem-watcher-lifecycle-state'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  clearLocalCapacityRetry,
  registerWatcherSenderCleanup
} from './filesystem-watcher-listener-lifecycle'
import { isWatcherRemovalInProgressError } from './watcher-removal-gate'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'

export type SubscribeLocalWatcher = (worktreePath: string, sender: WebContents) => Promise<void>

export function scheduleLocalCapacityRetry(
  rootKey: string,
  worktreePath: string,
  listeners: Map<number, WebContents>,
  subscribe: SubscribeLocalWatcher
): void {
  const existing = watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)
  if (existing) {
    for (const listener of listeners.values()) {
      if (!listener.isDestroyed()) {
        existing.listeners.set(listener.id, listener)
      }
    }
    return
  }

  let retry!: LocalWatcherCapacityRetry
  const cancelWait = onWatcherChildCapacityAvailable(async () => {
    if (watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey) !== retry) {
      return
    }
    watcherLifecycleState.pendingLocalCapacityRetries.delete(rootKey)
    await Promise.all(
      [...retry.listeners.values()].map(async (listener) => {
        if (listener.isDestroyed()) {
          return
        }
        await subscribe(worktreePath, listener).catch((error: unknown) => {
          if (!isWatcherRemovalInProgressError(error)) {
            console.error(`[filesystem-watcher] capacity retry failed for ${rootKey}:`, error)
          }
        })
        // Why: the IPC call returned before this install, so writes in between were never reported.
        const root = watcherLifecycleState.watchedRoots.get(rootKey)
        if (root?.listeners.has(listener.id) && !listener.isDestroyed()) {
          listener.send('fs:changed', {
            worktreePath: root.rootPath,
            events: [{ kind: 'overflow', absolutePath: root.rootPath }]
          } satisfies FsChangedPayload)
        }
      })
    )
  })
  retry = { listeners: new Map(), cancelWait }
  watcherLifecycleState.pendingLocalCapacityRetries.set(rootKey, retry)
  for (const listener of listeners.values()) {
    if (!listener.isDestroyed()) {
      retry.listeners.set(listener.id, listener)
      registerWatcherSenderCleanup(listener)
    }
  }
  if (retry.listeners.size === 0) {
    clearLocalCapacityRetry(rootKey)
  }
}
