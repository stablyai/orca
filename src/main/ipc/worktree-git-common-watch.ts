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
  createDegradedBaselineGate,
  startAdaptiveGitCommonPoller,
  tryTakeGitCommonPollBaseline,
  type AdaptiveGitCommonPollSubscription,
  type GitCommonPollingCadence
} from './worktree-git-common-poll-cadence'
import { startGitCommonPolling } from './worktree-git-common-polling'
import {
  PRIMARY_CHECKOUT_METADATA_FILES,
  snapshotPrimaryCheckoutMetadata,
  type PrimaryCheckoutMetadataSnapshot
} from './worktree-git-common-snapshot'

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
  takeSnapshot: (previous?: Map<string, number>) => Promise<PrimaryCheckoutMetadataSnapshot>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  // No index backstop: this poller re-stats every file each tick, so there is no gated
  // read for a forced full scan to unblock.
  cadence: Pick<GitCommonPollingCadence, 'activeIntervalMs' | 'idleIntervalMs'>,
  visibility: WorktreePollerWindowVisibility,
  onFullScan: (() => void) | undefined,
  onBaselineRecovered: () => void
): Promise<AdaptiveGitCommonPollSubscription> {
  let disposed = false
  // Why: a degraded scan has no previous view to retain at baseline time, so it simply omits the
  // files it could not read. Committing that as authoritative makes the next clean tick diff them
  // as creates; wait out a bounded number of whole ones instead.
  const deferDegradedBaseline = createDegradedBaselineGate()
  const baseline = await tryTakeGitCommonPollBaseline(
    () => takeSnapshot(),
    'primary-checkout metadata'
  )
  let snapshot = baseline && !deferDegradedBaseline(baseline.degraded) ? baseline.mtimes : null
  const polling = startAdaptiveGitCommonPoller({
    cadence: { activeIntervalMs: cadence.activeIntervalMs, idleIntervalMs: cadence.idleIntervalMs },
    visibility,
    poll: async () => {
      onFullScan?.()
      const next = await takeSnapshot(snapshot ?? undefined)
      if (disposed) {
        return { changed: false }
      }
      if (!snapshot) {
        if (deferDegradedBaseline(next.degraded)) {
          return { changed: false, degraded: true }
        }
        snapshot = next.mtimes
        onBaselineRecovered()
        return { changed: true }
      }
      const events = diffMtimeMap(snapshot, next.mtimes)
      snapshot = next.mtimes
      if (events.length > 0) {
        onEvents(events)
      }
      return { changed: events.length > 0, degraded: next.degraded }
    }
  })

  return {
    resetCadence: polling.resetCadence,
    unsubscribe: async () => {
      disposed = true
      await polling.unsubscribe()
    }
  }
}

async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onActivity: () => void
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  let subscribing = false
  let parkedWhileHidden = false

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
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
        onActivity()
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
            onActivity()
            onEvents([{ type: 'update', path: worktreesDir }])
            teardownAndRearm()
            return
          }
          if (events.length > 0) {
            onActivity()
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
              onActivity()
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
      unsubscribeVisibility()
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
  onFullScan: (() => void) | undefined,
  // Why: required, not defaulted — the interval policy lives with the base-poller constants;
  // a local multiplier default here would silently desync when either constant changes.
  idlePollIntervalMs: number,
  indexBackstopIntervalMs: number
): Promise<WorktreeBaseSubscription> {
  const cadence: GitCommonPollingCadence = {
    activeIntervalMs: pollIntervalMs,
    idleIntervalMs: idlePollIntervalMs,
    indexBackstopIntervalMs
  }
  if (platform === 'darwin') {
    // Why: install both in parallel — a slow/blocked stat on a primary file must not delay the
    // FSEvents subscription (and with it, first linked-worktree create detection). The narrow watch
    // reaches the poller through a late-bound holder; events that land before the poller exists are
    // covered by the baseline it takes at that moment.
    let resetPrimaryPollCadence: () => void = () => {}
    const [primaryMetadataPoll, narrowWatch] = await Promise.all([
      startSnapshotDiffPoller(
        (previous) => snapshotPrimaryCheckoutMetadata(target.path, previous),
        onEvents,
        cadence,
        visibility,
        onFullScan,
        () =>
          onEvents(
            PRIMARY_CHECKOUT_METADATA_FILES.map((name) => ({
              type: 'update',
              path: join(target.path, name)
            }))
          )
      ),
      startGitCommonNarrowWatch(target, onEvents, pollIntervalMs, visibility, () =>
        resetPrimaryPollCadence()
      )
    ])
    resetPrimaryPollCadence = primaryMetadataPoll.resetCadence
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryMetadataPoll.unsubscribe()])
      }
    }
  }
  return startGitCommonPolling(target.path, onEvents, cadence, visibility, onFullScan)
}
