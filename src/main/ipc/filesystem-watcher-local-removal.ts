import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS,
  type WatcherRemovalDeadline
} from './watcher-removal-drain'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  abandonLocalUnsubscribes,
  clearLocalCapacityRetry,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { subscribeLocalWatcher } from './filesystem-watcher-local-subscription'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'

export async function closeLocalWatcherForWorktreePath(
  worktreePath: string,
  deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline()
): Promise<void> {
  const { key: rootKey } = getLocalWatcherRoot(worktreePath)
  const suspended = watcherLifecycleState.suspendedLocalWatcherListeners.get(rootKey) ?? {
    worktreePath,
    listeners: new Map<number, WebContents>()
  }
  for (const source of [
    watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)?.listeners,
    watcherLifecycleState.inFlightLocalInstalls.get(rootKey)?.listeners,
    watcherLifecycleState.watchedRoots.get(rootKey)?.listeners
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
  if (suspended.listeners.size > 0) {
    watcherLifecycleState.suspendedLocalWatcherListeners.set(rootKey, suspended)
  }
  clearLocalCapacityRetry(rootKey)
  const pendingTeardown = watcherLifecycleState.pendingTeardowns.get(rootKey)
  if (pendingTeardown) {
    clearTimeout(pendingTeardown)
    watcherLifecycleState.pendingTeardowns.delete(rootKey)
  }

  const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    // Why: Windows locks watched directories; deletion must cancel an in-flight subscription before Git removes the tree.
    inFlight.listeners.clear()
    inFlight.cancelled = true
    inFlight.abortController.abort()
  }
  // Why: abort alone is not enough if the native subscribe never settles; bound so delete cannot hang the app.
  const pendingInstall = watcherLifecycleState.pendingLocalInstallPromises.get(rootKey)
  const installDrain = await drainBeforeWatcherRemoval(
    pendingInstall,
    deadline,
    `local watcher install for ${rootKey}`,
    { reserveMs: WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS }
  )
  if (installDrain === 'timeout') {
    // Why: an abandoned install never runs its own cleanup, so leaving these entries would make every
    // later watch of this root queue behind the same wedged promise. Identity-checked so a late settle
    // can't evict a newer install.
    if (watcherLifecycleState.pendingLocalInstallPromises.get(rootKey) === pendingInstall) {
      watcherLifecycleState.pendingLocalInstallPromises.delete(rootKey)
    }
    if (inFlight && watcherLifecycleState.inFlightLocalInstalls.get(rootKey) === inFlight) {
      watcherLifecycleState.inFlightLocalInstalls.delete(rootKey)
    }
  }
  const pendingUnsubscribes = watcherLifecycleState.pendingLocalUnsubscribesByRoot.get(rootKey)
  if (pendingUnsubscribes) {
    const draining = Array.from(pendingUnsubscribes)
    const unsubscribeDrain = await drainBeforeWatcherRemoval(
      // Why the per-promise catch: an already-abandoned unsubscribe belongs to a delete that finished
      // without it; re-raising its rejection here would fail a later close on stale news.
      Promise.all(
        draining.map((unsubscribe) =>
          watcherLifecycleState.abandonedLocalUnsubscribes.has(unsubscribe)
            ? unsubscribe.catch(() => undefined)
            : unsubscribe
        )
      ),
      deadline,
      `local watcher unsubscribe for ${rootKey}`,
      { reserveMs: WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS }
    )
    if (unsubscribeDrain === 'timeout') {
      abandonLocalUnsubscribes(draining)
    }
  }
  if (watcherLifecycleState.failedLocalUnsubscribes.has(rootKey)) {
    throw watcherLifecycleState.failedLocalUnsubscribes.get(rootKey)
  }

  const root = watcherLifecycleState.watchedRoots.get(rootKey)
  if (!root) {
    return
  }
  cancelLocalBatchFlush(root)
  watcherLifecycleState.watchedRoots.delete(rootKey)
  // Why: the in-process Parcel fallback has no unsubscribe timeout of its own, so an unbounded await
  // here would hang delete forever and hold the removal gate. The promise stays tracked in
  // pendingLocalUnsubscribesByRoot, so a later close still observes its failure.
  const finalUnsubscribe = trackDetachedLocalUnsubscribe(rootKey, root)
  const finalDrain = await drainBeforeWatcherRemoval(
    finalUnsubscribe,
    deadline,
    `local watcher unsubscribe for ${rootKey}`
  )
  if (finalDrain === 'timeout') {
    abandonLocalUnsubscribes([finalUnsubscribe])
  }
}

export async function restoreLocalWatcherAfterFailedRemoval(worktreePath: string): Promise<void> {
  const { key: rootKey } = getLocalWatcherRoot(worktreePath)
  const suspended = watcherLifecycleState.suspendedLocalWatcherListeners.get(rootKey)
  if (!suspended) {
    return
  }
  watcherLifecycleState.suspendedLocalWatcherListeners.delete(rootKey)
  const failures: unknown[] = []
  const failedListeners = new Map<number, WebContents>()
  for (const sender of suspended.listeners.values()) {
    if (sender.isDestroyed()) {
      continue
    }
    try {
      await subscribeLocalWatcher(suspended.worktreePath, sender)
      sender.send('fs:changed', {
        worktreePath: suspended.worktreePath,
        events: [{ kind: 'overflow', absolutePath: suspended.worktreePath }]
      } satisfies FsChangedPayload)
    } catch (error) {
      failures.push(error)
      failedListeners.set(sender.id, sender)
    }
  }
  if (failures.length > 0) {
    watcherLifecycleState.suspendedLocalWatcherListeners.set(rootKey, {
      worktreePath: suspended.worktreePath,
      listeners: failedListeners
    })
    throw failures[0]
  }
}

export function forgetLocalWatcherRemovalSnapshot(worktreePath: string): void {
  watcherLifecycleState.suspendedLocalWatcherListeners.delete(getLocalWatcherRoot(worktreePath).key)
}
