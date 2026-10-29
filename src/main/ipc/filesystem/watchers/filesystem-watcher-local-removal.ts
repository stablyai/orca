import { isCurrentWatcherSender } from './filesystem-watcher-sender-lifetime'
import type { WebContents } from 'electron'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS,
  type WatcherRemovalDeadline
} from '../../watcher-removal-drain'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  abandonLocalUnsubscribes,
  registerWatcherSenderCleanup,
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
  const waiters = watcherLifecycleState.cancelledLocalInstallWaiters.get(rootKey)
  for (const source of [
    watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)?.listeners,
    watcherLifecycleState.inFlightLocalInstalls.get(rootKey)?.listeners,
    watcherLifecycleState.watchedRoots.get(rootKey)?.listeners,
    new Map(Array.from(waiters?.values() ?? [], ({ sender }) => [sender.id, sender]))
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
  // Restore owns retries after this close; waiters must not install independently.
  watcherLifecycleState.cancelledLocalInstallWaiters.delete(rootKey)
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
    // Windows locks watched directories; cancel installs before Git deletes their roots.
    inFlight.listeners.clear()
    inFlight.cancelled = true
    inFlight.abortController.abort()
  }
  // Abort cannot settle wedged native subscriptions; bound removal drains.
  const pendingInstall = watcherLifecycleState.pendingLocalInstallPromises.get(rootKey)
  const installDrain = await drainBeforeWatcherRemoval(
    pendingInstall,
    deadline,
    `local watcher install for ${rootKey}`,
    { reserveMs: WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS }
  )
  if (installDrain === 'timeout') {
    // Retire abandoned install slots by identity so later watches do not inherit a wedge or lose newer installs.
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
      // Timed-out prior drains must not fail a later close with stale rejections.
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
  // Bound fallback unsubscribe too; retain its promise so later closes can observe non-abandoned failures.
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
  const failures: {
    sender: WebContents
    signal: AbortSignal
    error: unknown
  }[] = []
  const owners = Array.from(suspended.listeners.values(), (sender) => ({
    sender,
    signal: registerWatcherSenderCleanup(sender)
  }))
  const suspendedByKey = watcherLifecycleState.suspendedLocalWatcherListeners
  for (const { sender, signal } of owners) {
    // Replaced snapshots belong to a newer removal.
    if (suspendedByKey.get(rootKey) !== suspended) {
      break
    }
    // Withdraw owners only at their turn; reject old page lifetimes before consuming reloaded-window entries.
    if (!isCurrentWatcherSender(sender, signal) || !suspended.listeners.delete(sender.id)) {
      continue
    }
    try {
      await subscribeLocalWatcher(suspended.worktreePath, sender, undefined, signal)
      if (!isCurrentWatcherSender(sender, signal)) {
        continue
      }
      sender.send('fs:changed', {
        worktreePath: suspended.worktreePath,
        events: [{ kind: 'overflow', absolutePath: suspended.worktreePath }],
        resync: true
      } satisfies FsChangedPayload)
    } catch (error) {
      if (!isCurrentWatcherSender(sender, signal)) {
        continue
      }
      failures.push({ sender, signal, error })
    }
  }
  // A retried removal may have added owners back into this snapshot.
  if (suspendedByKey.get(rootKey) === suspended && suspended.listeners.size === 0) {
    suspendedByKey.delete(rootKey)
  }
  const liveFailures = failures.filter(({ sender, signal }) =>
    isCurrentWatcherSender(sender, signal)
  )
  if (liveFailures.length > 0) {
    const current = suspendedByKey.get(rootKey) ?? {
      worktreePath: suspended.worktreePath,
      listeners: new Map<number, WebContents>()
    }
    for (const { sender } of liveFailures) {
      current.listeners.set(sender.id, sender)
    }
    suspendedByKey.set(rootKey, current)
    throw liveFailures[0].error
  }
}

export function forgetLocalWatcherRemovalSnapshot(worktreePath: string): void {
  watcherLifecycleState.suspendedLocalWatcherListeners.delete(getLocalWatcherRoot(worktreePath).key)
}
