import type { WebContents } from 'electron'
import { onWatcherChildCapacityAvailable } from './parcel-watcher-child-registry'
import type { LocalWatcherCapacityRetry } from './filesystem-watcher-lifecycle-state'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  clearLocalCapacityRetry,
  registerWatcherSenderCleanup
} from './filesystem-watcher-listener-lifecycle'
import { isWatcherRemovalInProgressError } from './watcher-removal-gate'

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
