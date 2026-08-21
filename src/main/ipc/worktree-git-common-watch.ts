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
import { startGitCommonPolling } from './worktree-git-common-polling'
import { startGitCommonPrimaryPolling } from './worktree-git-common-primary-polling'

// Watches a repo's `<common>/.git/worktrees` metadata plus the primary
// checkout's shallow branch/index files — the only paths the git-common event
// filter consumes.
// macOS: a narrow native stream rooted at `worktrees/` — a tiny, rare-churn
// tree — gives instant detection with zero idle cost and zero wide-scope
// fseventsd delivery; the primary files are covered by a few stat calls per
// tick (a native stream would have to span the whole common dir, objects
// included). Other platforms: dir-listing poll (no fseventsd to protect, and
// on Windows an open directory handle on `worktrees/` could interfere with
// `git worktree prune` removing it).
// The native stream is hosted in the crash-isolated watcher child, never the
// Electron main process: watcher.node teardown races heap-corrupt the hosting
// process when unsubscribe overlaps in-flight callbacks (issue #8732), and
// root deletion via `git worktree prune` makes that overlap routine here.

async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  let pollingFallbackPromise: Promise<void> | null = null
  let subscribing = false
  let parkedWhileHidden = false

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
  }

  const shouldUsePollingFallback = (error: unknown): boolean =>
    isWatcherProcessFailure(error) &&
    (error.code === 'supervisor_crash_fuse' || error.code === 'process_unavailable')

  const ensurePollingFallback = (): Promise<void> => {
    if (pollingFallbackPromise) {
      return pollingFallbackPromise
    }
    stopExistencePoll()
    const pending = startGitCommonPolling(
      target.path,
      onEvents,
      pollIntervalMs,
      visibility,
      onFullScan,
      false
    ).then(async (fallback) => {
      if (disposed || subscription) {
        await fallback.unsubscribe()
        return
      }
      subscription = fallback
    })
    const tracked = pending.finally(() => {
      if (pollingFallbackPromise === tracked) {
        pollingFallbackPromise = null
      }
    })
    pollingFallbackPromise = tracked
    return pollingFallbackPromise
  }

  const tryUpgradeToNarrowWatch = async (): Promise<void> => {
    if (disposed || subscribing || subscription) {
      return
    }
    subscribing = true
    try {
      const installed = await trySubscribe()
      if (installed && !disposed) {
        stopExistencePoll()
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
      // Why: a hidden window has nothing to refresh, so stop stat'ing the dir
      // entirely instead of burning a syscall per repo per tick in the background.
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
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    // Why: the first linked worktree may have been registered while hidden — check
    // now (emitting the create) rather than losing it for a full interval.
    void tryUpgradeToNarrowWatch().finally(() => {
      armExistencePoll()
    })
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
          if (disposed || !active) {
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
        {},
        {
          // Why: a watcher-child crash drops events during the automatic
          // resubscribe gap; report a structural change so worktrees re-sync.
          onInterruption: () => {
            if (!disposed && active) {
              if (onWatchError) {
                onWatchError(new Error('Git common watcher interrupted'))
              } else {
                onEvents([{ type: 'update', path: worktreesDir }])
              }
            }
          }
        }
      )
      if (disposed || errored) {
        void sub.unsubscribe().catch(() => {})
        await pollingFallbackPromise?.catch(() => {})
        return !errored || subscription !== null
      }
      subscription = { unsubscribe: () => sub.unsubscribe() }
      return true
    } catch (error) {
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

  return {
    unsubscribe: async () => {
      disposed = true
      stopExistencePoll()
      unsubscribeVisibility()
      await pollingFallbackPromise?.catch(() => {})
      const current = subscription
      subscription = null
      if (current) {
        await current.unsubscribe().catch(() => {})
      }
    }
  }
}

export async function startGitCommonWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  getStatusRefPaths: () => readonly string[] = () => [],
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  if (platform === 'darwin') {
    const [narrowWatch, primaryMetadataPoll] = await Promise.all([
      startGitCommonNarrowWatch(
        target,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan,
        onWatchError
      ),
      startGitCommonPrimaryPolling(
        target.path,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan
      )
    ])
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryMetadataPoll.unsubscribe()])
      }
    }
  }
  return startGitCommonPolling(
    target.path,
    onEvents,
    pollIntervalMs,
    visibility,
    onFullScan,
    true,
    getStatusRefPaths
  )
}
