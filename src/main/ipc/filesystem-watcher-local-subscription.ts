import type { WebContents } from 'electron'
import { beginWatcherInstall } from './watcher-removal-gate'
import type { LocalWatcherInstallToken } from './filesystem-watcher-lifecycle-state'
import {
  WATCHER_TEARDOWN_GRACE_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import {
  addInFlightLocalInstallListener,
  addLocalWatchListener,
  clearLocalCapacityRetry,
  rememberUnwatchableRoot,
  takeLocalCapacityRetryListeners,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { scheduleLocalCapacityRetry } from './filesystem-watcher-local-capacity'
import { installLocalWatcher } from './filesystem-watcher-local-install'

// ── Subscribe / Unsubscribe ──────────────────────────────────────────

export async function subscribeLocalWatcher(
  worktreePath: string,
  sender: WebContents,
  generation = watcherLifecycleState.localWatcherLifecycleGeneration
): Promise<void> {
  if (
    watcherLifecycleState.localWatchersClosed ||
    generation !== watcherLifecycleState.localWatcherLifecycleGeneration
  ) {
    return
  }
  const finishInstall = beginWatcherInstall(worktreePath)
  try {
    await subscribeWhileRemovalAllowed(worktreePath, sender, generation)
  } finally {
    finishInstall()
  }
}

async function subscribeWhileRemovalAllowed(
  worktreePath: string,
  sender: WebContents,
  generation: number
): Promise<void> {
  if (
    watcherLifecycleState.localWatchersClosed ||
    generation !== watcherLifecycleState.localWatcherLifecycleGeneration
  ) {
    return
  }
  const { key: rootKey, path: rootPath } = getLocalWatcherRoot(worktreePath)
  if (sender.isDestroyed()) {
    return
  }

  // Don't retry roots that already failed — avoids repeated error spam.
  if (watcherLifecycleState.unwatchableRoots.has(rootKey)) {
    rememberUnwatchableRoot(rootKey)
    return
  }

  const root = watcherLifecycleState.watchedRoots.get(rootKey)

  // Cancel any pending grace-period teardown — a new listener arrived.
  const pendingTeardown = watcherLifecycleState.pendingTeardowns.get(rootKey)
  if (pendingTeardown) {
    clearTimeout(pendingTeardown)
    watcherLifecycleState.pendingTeardowns.delete(rootKey)
  }
  const capacityRetryListeners = takeLocalCapacityRetryListeners(rootKey)

  if (root) {
    for (const listener of capacityRetryListeners) {
      addLocalWatchListener(rootKey, listener)
    }
    addLocalWatchListener(rootKey, sender)
    return
  }

  const pendingInstall = watcherLifecycleState.pendingLocalInstallPromises.get(rootKey)
  if (pendingInstall) {
    const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
    const canJoinInstall = inFlight && !inFlight.abortController.signal.aborted
    if (canJoinInstall) {
      // Why: an unwatch may cancel an install while another renderer awaits the same root; a new live listener keeps it alive.
      addInFlightLocalInstallListener(inFlight, sender)
      for (const listener of capacityRetryListeners) {
        addInFlightLocalInstallListener(inFlight, listener)
      }
    }
    const result = await pendingInstall
    if (
      result === 'cancelled' &&
      !canJoinInstall &&
      !watcherLifecycleState.localWatchersClosed &&
      generation === watcherLifecycleState.localWatcherLifecycleGeneration
    ) {
      // Why: AbortSignal can't be revived; listeners arriving after cancellation wait out that generation, then own a fresh install.
      if (watcherLifecycleState.pendingLocalInstallPromises.get(rootKey) === pendingInstall) {
        watcherLifecycleState.pendingLocalInstallPromises.delete(rootKey)
      }
      const retryListeners = new Map(
        capacityRetryListeners.map((listener) => [listener.id, listener])
      )
      retryListeners.set(sender.id, sender)
      for (const listener of retryListeners.values()) {
        if (!listener.isDestroyed()) {
          await subscribeWhileRemovalAllowed(worktreePath, listener, generation)
        }
      }
      return
    }
    if (!inFlight) {
      if (result === 'installed') {
        for (const listener of capacityRetryListeners) {
          addLocalWatchListener(rootKey, listener)
        }
      } else if (result === 'capacity') {
        const retryListeners = new Map(
          capacityRetryListeners.map((listener) => [listener.id, listener])
        )
        retryListeners.set(sender.id, sender)
        scheduleLocalCapacityRetry(rootKey, worktreePath, retryListeners, subscribeLocalWatcher)
      }
    }
    if (
      result === 'installed' &&
      watcherLifecycleState.watchedRoots.has(rootKey) &&
      !sender.isDestroyed() &&
      (!inFlight || inFlight.listeners.has(sender.id))
    ) {
      addLocalWatchListener(rootKey, sender)
    }
    return
  }

  const cancelToken: LocalWatcherInstallToken = {
    cancelled: false,
    listeners: new Map(),
    abortController: new AbortController()
  }
  watcherLifecycleState.inFlightLocalInstalls.set(rootKey, cancelToken)
  for (const listener of capacityRetryListeners) {
    addInFlightLocalInstallListener(cancelToken, listener)
  }
  addInFlightLocalInstallListener(cancelToken, sender)
  const installPromise = installLocalWatcher(
    rootKey,
    rootPath,
    worktreePath,
    cancelToken,
    (listeners) =>
      scheduleLocalCapacityRetry(rootKey, worktreePath, listeners, subscribeLocalWatcher)
  )
  watcherLifecycleState.pendingLocalInstallPromises.set(rootKey, installPromise)
  try {
    await installPromise
  } finally {
    if (watcherLifecycleState.pendingLocalInstallPromises.get(rootKey) === installPromise) {
      watcherLifecycleState.pendingLocalInstallPromises.delete(rootKey)
    }
  }
}

export function unsubscribeLocalWatcher(worktreePath: string, senderId: number): void {
  const { key: rootKey } = getLocalWatcherRoot(worktreePath)
  const suspended = watcherLifecycleState.suspendedLocalWatcherListeners.get(rootKey)
  suspended?.listeners.delete(senderId)
  if (suspended?.listeners.size === 0) {
    watcherLifecycleState.suspendedLocalWatcherListeners.delete(rootKey)
  }
  const capacityRetry = watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)
  if (capacityRetry) {
    capacityRetry.listeners.delete(senderId)
    if (capacityRetry.listeners.size === 0) {
      clearLocalCapacityRetry(rootKey)
    }
  }
  const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    inFlight.listeners.delete(senderId)
    inFlight.cancelled = inFlight.listeners.size === 0
    // Why: last normal disconnect must abort the pending native/forked install (same early-cancel as closeLocalWatcherForWorktreePath).
    if (inFlight.cancelled) {
      inFlight.abortController.abort()
    }
  }

  const root = watcherLifecycleState.watchedRoots.get(rootKey)
  if (!root) {
    return
  }

  root.listeners.delete(senderId)

  // Defer teardown when the last subscriber leaves so rapid worktree switches reuse the native watcher.
  if (root.listeners.size === 0) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    // Why: duplicate unwatch calls for a root would leak overwritten grace timers; keep just one.
    if (watcherLifecycleState.pendingTeardowns.has(rootKey)) {
      return
    }

    const teardownTimer = setTimeout(() => {
      watcherLifecycleState.pendingTeardowns.delete(rootKey)
      // Re-check: a new listener may have arrived during the grace period.
      const currentRoot = watcherLifecycleState.watchedRoots.get(rootKey)
      if (!currentRoot || currentRoot.listeners.size > 0) {
        return
      }
      void trackDetachedLocalUnsubscribe(rootKey, currentRoot)
      cancelLocalBatchFlush(currentRoot)
      watcherLifecycleState.watchedRoots.delete(rootKey)
    }, WATCHER_TEARDOWN_GRACE_MS)

    watcherLifecycleState.pendingTeardowns.set(rootKey, teardownTimer)
  }
}
