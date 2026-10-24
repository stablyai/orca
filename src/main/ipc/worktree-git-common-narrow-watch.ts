import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { createSingleFlight } from './single-flight-promise'
import { createGitCommonWatchReconciliation } from './worktree-git-common-watch-reconciliation'
import { startGitCommonPolling } from './worktree-git-common-polling'
import { createNativeUpgradePoll } from './worktree-git-common-native-upgrade-poll'

// Isolate native watchers in children: unsubscribe races can corrupt the host heap when prune deletes a root (#8732).

export async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  onWatchError?: (error: Error) => void,
  // Overflow proves lost events and must bypass the transient watcher-error cooldown.
  onOverflow?: () => void
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  const watcherOptions = platform === 'win32' ? { backend: 'windows' as const } : {}
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  const pollingFallback = createSingleFlight()
  let subscribing = false
  let parkedWhileHidden = false
  let usingPollingFallback = false
  let nativeSubscriptionGeneration = 0
  const reconciliation = createGitCommonWatchReconciliation({
    commonDirPath: target.path,
    pollIntervalMs,
    visibility,
    canStart: () => !disposed && !usingPollingFallback && subscription !== null,
    shouldKeep: () => !disposed && !usingPollingFallback,
    onRootReplacement: () => {
      nativeSubscriptionGeneration++
      const current = subscription
      subscription = null
      if (current) {
        void current.unsubscribe().catch(() => {})
      }
      armExistencePoll()
    },
    onEvents
  })

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
  }

  const shouldUsePollingFallback = (error: unknown): boolean =>
    isWatcherProcessFailure(error) &&
    (error.code === 'supervisor_crash_fuse' || error.code === 'process_unavailable')

  const ensurePollingFallback = (): Promise<void> =>
    pollingFallback.run(() => {
      stopExistencePoll()
      usingPollingFallback = true
      return reconciliation
        .unsubscribe()
        .catch(() => {})
        .then(() =>
          // While the native crash fuse is open, gated polling remains the sole change source.
          startGitCommonPolling(
            target.path,
            onEvents,
            pollIntervalMs,
            visibility,
            onFullScan,
            false
          )
        )
        .then(async (fallback) => {
          if (disposed || subscription) {
            await fallback.unsubscribe()
            return
          }
          subscription = fallback
          upgradePoll.arm()
        })
    })

  const upgradeFromPollingFallback = async (): Promise<void> => {
    if (
      disposed ||
      subscribing ||
      !usingPollingFallback ||
      pollingFallback.pending() ||
      !visibility.isWindowVisible()
    ) {
      return
    }
    const fallback = subscription
    const attemptGeneration = nativeSubscriptionGeneration + 1
    subscribing = true
    try {
      const installed = await trySubscribe()
      // A torn-down attempt bumps the generation and may have swapped pollers.
      if (!installed || disposed || nativeSubscriptionGeneration !== attemptGeneration) {
        return
      }
      upgradePoll.stop()
      usingPollingFallback = false
      await fallback?.unsubscribe().catch(() => {})
      await reconciliation.ensureStarted()
      // Resync past the polling window now that native events resume.
      onEvents([{ type: 'update', path: worktreesDir }])
    } finally {
      subscribing = false
    }
  }

  const upgradePoll = createNativeUpgradePoll(upgradeFromPollingFallback)

  const tryUpgradeToNarrowWatch = async (): Promise<void> => {
    if (disposed || subscribing || subscription) {
      return
    }
    subscribing = true
    try {
      const installed = await trySubscribe()
      if (installed && !disposed) {
        stopExistencePoll()
        await reconciliation.ensureStarted()
        // The dir appearing means a first linked worktree was just
        // registered; surface it so the repo's worktree list refreshes.
        onEvents([{ type: 'create', path: worktreesDir }])
      }
    } finally {
      subscribing = false
    }
  }

  const armExistencePoll = (): void => {
    if (disposed || existenceTimer || subscription) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    existenceTimer = setInterval(() => {
      if (disposed) {
        return
      }
      if (!visibility.isWindowVisible()) {
        parkedWhileHidden = true
        stopExistencePoll()
        return
      }
      void tryUpgradeToNarrowWatch()
    }, pollIntervalMs)
    existenceTimer.unref?.()
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (!disposed && parkedWhileHidden) {
      parkedWhileHidden = false
      void tryUpgradeToNarrowWatch().finally(() => {
        armExistencePoll()
      })
    }
    reconciliation.notifyWindowBecameVisible()
  })

  const trySubscribe = async (): Promise<boolean> => {
    try {
      const s = await stat(worktreesDir)
      if (!s.isDirectory()) {
        return false
      }
    } catch {
      return false
    }
    const generation = ++nativeSubscriptionGeneration
    let errored = false
    let active = true
    // Root deletion kills native streams; notify, retire, and let existence polling rearm after recreation.
    const teardown = (): void => {
      active = false
      errored = true
      if (generation === nativeSubscriptionGeneration) {
        nativeSubscriptionGeneration++
      }
      const current = subscription
      subscription = null
      if (current) {
        void current.unsubscribe().catch(() => {})
      }
    }
    const teardownAndRearm = (): void => {
      teardown()
      armExistencePoll()
    }
    try {
      const sub = await subscribeViaWatcherProcess(
        worktreesDir,
        (error, events) => {
          if (disposed || !active || generation !== nativeSubscriptionGeneration) {
            return
          }
          if (error) {
            if (onWatchError) {
              onWatchError(error)
            } else {
              onEvents([{ type: 'update', path: worktreesDir }])
            }
            if (shouldUsePollingFallback(error)) {
              teardown()
              void ensurePollingFallback().catch(() => {
                if (!disposed) {
                  armExistencePoll()
                }
              })
            } else {
              teardownAndRearm()
            }
            return
          }
          if (events.length > 0) {
            const rootGone = events.some(
              (event) => event.type === 'delete' && event.path === worktreesDir
            )
            onEvents(events.map((event) => ({ type: event.type, path: event.path })))
            if (rootGone) {
              teardownAndRearm()
            }
          }
        },
        watcherOptions,
        {
          // Child crashes lose events during resubscribe; force structural resync.
          onInterruption: () => {
            if (!disposed && active && generation === nativeSubscriptionGeneration) {
              if (onWatchError) {
                onWatchError(new Error('Git common watcher interrupted'))
              } else {
                onEvents([{ type: 'update', path: worktreesDir }])
              }
            }
          },
          // Dropped/overflowed batches identify no paths; always widen beyond the watcher-error cooldown.
          onOverflow: () => {
            if (disposed || !active || generation !== nativeSubscriptionGeneration) {
              return
            }
            if (onOverflow) {
              onOverflow()
            } else if (onWatchError) {
              onWatchError(new Error('Git common watcher overflowed'))
            } else {
              onEvents([{ type: 'update', path: worktreesDir }])
            }
          }
        }
      )
      if (generation !== nativeSubscriptionGeneration) {
        void sub.unsubscribe().catch(() => {})
        return false
      }
      if (disposed || errored) {
        void sub.unsubscribe().catch(() => {})
        await pollingFallback.pending()?.catch(() => {})
        return !errored || subscription !== null
      }
      subscription = { unsubscribe: () => sub.unsubscribe() }
      return true
    } catch (error) {
      if (disposed || generation !== nativeSubscriptionGeneration) {
        return false
      }
      if (shouldUsePollingFallback(error)) {
        if (usingPollingFallback) {
          return false
        }
        await ensurePollingFallback()
        return subscription !== null
      }
      return false
    }
  }

  if (!(await trySubscribe())) {
    // Repos may have no linked worktree directory yet; upgrade to native events when it appears.
    armExistencePoll()
  }
  await reconciliation.ensureStarted()

  return {
    unsubscribe: async () => {
      disposed = true
      stopExistencePoll()
      upgradePoll.stop()
      unsubscribeVisibility()
      await pollingFallback.pending()?.catch(() => {})
      nativeSubscriptionGeneration++
      const current = subscription
      subscription = null
      await Promise.all([
        current?.unsubscribe().catch(() => {}),
        reconciliation.unsubscribe().catch(() => {})
      ])
    }
  }
}
