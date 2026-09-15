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

// The native stream is hosted in the crash-isolated watcher child, never the
// Electron main process: watcher.node teardown races heap-corrupt the hosting
// process when unsubscribe overlaps in-flight callbacks (issue #8732), and
// root deletion via `git worktree prune` makes that overlap routine here.

export async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  onWatchError?: (error: Error) => void,
  // Why: a dropped event batch (>5,000 events, e.g. a fleet-wide bulk op) is a
  // harder loss signal than a transient error — nothing about the prior state
  // can be trusted, so this bypasses onWatchError's failure cooldown instead
  // of reusing it.
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
          // Crash fuse tripped: this poller is now the sole change signal until a
          // future existence-poll upgrade (follow-up: #17878). Its own per-entry
          // dir-signature gate (worktree-git-common-entry-snapshot.ts) already keeps
          // an unchanged entry to a single stat, so a fixed `pollIntervalMs` cadence
          // stays cheap at high worktree counts without needing to stretch itself.
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
        })
    })

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
    // Why: parcel tears its native stream down when the watched root is
    // deleted (e.g. `git worktree prune` removing an empty worktrees dir) —
    // sometimes surfaced as an error, sometimes as a delete event for the
    // root. Either way: notify, drop the dead stream, and let the existence
    // poll re-arm when a future worktree add recreates the dir.
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
          // Why: a watcher-child crash drops events during the automatic
          // resubscribe gap; report a structural change so worktrees re-sync.
          onInterruption: () => {
            if (!disposed && active && generation === nativeSubscriptionGeneration) {
              if (onWatchError) {
                onWatchError(new Error('Git common watcher interrupted'))
              } else {
                onEvents([{ type: 'update', path: worktreesDir }])
              }
            }
          },
          // Why: the watcher child drops the whole batch past 5,000 events
          // (native FSEvents overflow maps to the same op) instead of reporting
          // which paths changed. Unlike a transient error, this is definite
          // proof of loss, so it always widens rather than falling back to the
          // failure-cooldown-gated onWatchError path.
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
        await ensurePollingFallback()
        return subscription !== null
      }
      return false
    }
  }

  if (!(await trySubscribe())) {
    // Why: repos commonly start without linked worktrees; retrying the narrow
    // subscription lets macOS upgrade to native events when the directory appears.
    armExistencePoll()
  }
  await reconciliation.ensureStarted()

  return {
    unsubscribe: async () => {
      disposed = true
      stopExistencePoll()
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
