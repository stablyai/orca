import type { WebContents } from 'electron'
import {
  LOCAL_WATCH_REARM_MAX_MS,
  LOCAL_WATCH_REARM_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import type { SubscribeLocalWatcher } from './filesystem-watcher-local-capacity'
import { scheduleLocalCapacityRetry } from './filesystem-watcher-local-capacity'
import { sendLocalWatcherOverflow } from './filesystem-watcher-local-events'

export function scheduleLocalWatcherRearm(
  rootKey: string,
  worktreePath: string,
  listeners: Map<number, WebContents>,
  subscribe: SubscribeLocalWatcher
): void {
  const now = Date.now()
  const prev = watcherLifecycleState.localWatcherRearmBackoff.get(rootKey)
  // Why: a re-armed watcher that stayed healthy as long as its last wait is a new incident, so the backoff restarts.
  const delayMs =
    !prev || now - prev.erroredAt - prev.delayMs >= prev.delayMs
      ? LOCAL_WATCH_REARM_MS
      : Math.min(prev.delayMs * 2, LOCAL_WATCH_REARM_MAX_MS)
  watcherLifecycleState.localWatcherRearmBackoff.set(rootKey, { delayMs, erroredAt: now })

  const wait = (onReady: () => void | Promise<void>): (() => void) => {
    const timer = setTimeout(() => void onReady(), delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }

  const subscribeAndResync: SubscribeLocalWatcher = async (path, listener) => {
    await subscribe(path, listener)
    const root = watcherLifecycleState.watchedRoots.get(rootKey)
    if (!root || root.listeners.get(listener.id) !== listener || listener.isDestroyed()) {
      return
    }
    // Why: events between the error and the re-arm were lost.
    sendLocalWatcherOverflow(listener, root.rootPath)
  }

  scheduleLocalCapacityRetry(rootKey, worktreePath, listeners, subscribeAndResync, wait)
}
