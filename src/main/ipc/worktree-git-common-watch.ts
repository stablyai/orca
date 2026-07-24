import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import {
  PRIMARY_CHECKOUT_METADATA_FILES,
  startGitCommonPolling
} from './worktree-git-common-polling'

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

// Why: branch switches and commits made in the primary checkout rewrite these
// top-level files (linked-worktree equivalents live under `worktrees/`).
// Deliberately excludes FETCH_HEAD-style churn that carries no status change.
async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string
): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>()
  for (const name of PRIMARY_CHECKOUT_METADATA_FILES) {
    const filePath = join(commonDirPath, name)
    try {
      mtimes.set(filePath, (await stat(filePath)).mtimeMs)
    } catch {
      // Missing file (e.g. no packed-refs yet) diffs into a create later.
    }
  }
  return mtimes
}

function diffMtimeMap(
  prev: Map<string, number>,
  next: Map<string, number>
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  for (const [path, mtime] of next) {
    const prevMtime = prev.get(path)
    if (prevMtime === undefined) {
      events.push({ type: 'create', path })
    } else if (prevMtime !== mtime) {
      events.push({ type: 'update', path })
    }
  }
  for (const path of prev.keys()) {
    if (!next.has(path)) {
      events.push({ type: 'delete', path })
    }
  }
  return events
}

async function startSnapshotDiffPoller(
  takeSnapshot: () => Promise<Map<string, number>>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let snapshot = await takeSnapshot()
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

  const tick = async (): Promise<void> => {
    timer = null
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    if (ticking) {
      return
    }
    ticking = true
    // Why: measure from tick start so cadence is start-to-start, not gap-after-completion (which would
    // land each visible refresh a full scan-duration late every tick).
    const startedAt = Date.now()
    onFullScan?.()
    try {
      const next = await takeSnapshot()
      if (disposed) {
        return
      }
      const events = diffMtimeMap(snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Why: clamp to [0, pollIntervalMs]. Date.now() is not monotonic — a backward wall-clock jump (NTP) would
      // otherwise make elapsed negative and push the next tick out by the adjustment (suppressing refreshes for
      // minutes); the upper clamp caps the wait at one interval, the lower clamp keeps a long scan from going negative.
      const nextDelay = Math.max(
        0,
        Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
      )
      timer = setTimeout(() => void tick(), nextDelay)
      timer.unref?.()
    }
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    void tick()
  })

  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
    }
  }
}

async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  let subscribing = false

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
  }

  const armExistencePoll = (): void => {
    if (disposed || existenceTimer) {
      return
    }
    existenceTimer = setInterval(() => {
      if (disposed || subscribing || subscription) {
        return
      }
      subscribing = true
      void trySubscribe()
        .then((installed) => {
          if (installed && !disposed) {
            stopExistencePoll()
            // The dir appearing means a first linked worktree was just
            // registered; surface it so the repo's worktree list refreshes.
            onEvents([{ type: 'create', path: worktreesDir }])
          }
        })
        .finally(() => {
          subscribing = false
        })
    }, pollIntervalMs)
    existenceTimer.unref?.()
  }

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
    const teardownAndRearm = (): void => {
      active = false
      errored = true
      const current = subscription
      subscription = null
      if (current) {
        void current.unsubscribe().catch(() => {})
      }
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
            onEvents([{ type: 'update', path: worktreesDir }])
            teardownAndRearm()
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
              onEvents([{ type: 'update', path: worktreesDir }])
            }
          }
        }
      )
      if (disposed || errored) {
        void sub.unsubscribe().catch(() => {})
        return !errored
      }
      subscription = { unsubscribe: () => sub.unsubscribe() }
      return true
    } catch {
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
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  if (platform === 'darwin') {
    const [narrowWatch, primaryMetadataPoll] = await Promise.all([
      startGitCommonNarrowWatch(target, onEvents, pollIntervalMs),
      startSnapshotDiffPoller(
        () => snapshotPrimaryCheckoutMetadata(target.path),
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
  return startGitCommonPolling(target.path, onEvents, pollIntervalMs, visibility, onFullScan)
}
