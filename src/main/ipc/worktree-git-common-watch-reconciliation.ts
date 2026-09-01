import { dirname, join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { gitCommonDirectorySignature } from './worktree-git-common-entry-snapshot'
import { startGitCommonPolling } from './worktree-git-common-polling'

// The native stream is still the fast path. A scheduled 15-tick reconciliation
// bounds silent watcher loss at the existing 30-second backstop without joining
// the per-repo 2-second timer fleet.
const NARROW_WATCH_RECONCILIATION_TICKS = 15

// Why: guards against a watcher-process loss that trips none of the explicit
// signals below (overflow/interruption/error/resubscribe) — a fully silent
// kernel-level drop. That's vanishingly rare, so a minutes-scale (10 ticks *
// ~30s) eventual-convergence bound is acceptable, same philosophy as the base
// poller's own ungated backstop scan (WORKTREE_BASE_BACKSTOP_TICKS).
const BELT_AND_BRACES_SWEEP_TICKS = 10

type GitCommonWatchReconciliationOptions = {
  commonDirPath: string
  pollIntervalMs: number
  visibility: WorktreePollerWindowVisibility
  canStart: () => boolean
  shouldKeep: () => boolean
  onRootReplacement: () => void
  onEvents: (events: WorktreeBasePollEvent[]) => void
}

type GitCommonWatchReconciliation = {
  ensureStarted: () => Promise<void>
  notifyWindowBecameVisible: () => void
  /** Overflow/interruption/error/resubscribe on the narrow watch mean events
   *  since then can't be trusted — arm the next tick to sweep unconditionally
   *  instead of waiting on the tripwire or belt-and-braces cadence. */
  notifyLossSignal: () => void
  unsubscribe: () => Promise<void>
}

export function createGitCommonWatchReconciliation({
  commonDirPath,
  pollIntervalMs,
  visibility,
  canStart,
  shouldKeep,
  onRootReplacement,
  onEvents
}: GitCommonWatchReconciliationOptions): GitCommonWatchReconciliation {
  const worktreesDir = join(commonDirPath, 'worktrees')
  let subscription: WorktreeBaseSubscription | null = null
  let lastSignature: string | null = null
  let pendingLossSweep = false
  let ticksSinceSweep = 0
  const visibilityListeners = new Set<() => void>()
  const pollVisibility: WorktreePollerWindowVisibility = {
    isWindowVisible: visibility.isWindowVisible,
    onWindowBecameVisible: (listener) => {
      visibilityListeners.add(listener)
      return () => {
        visibilityListeners.delete(listener)
      }
    }
  }

  // Why: a single stat of the worktrees dir replaces the unconditional O(n)
  // per-entry sweep every tick. The expensive sweep only runs when this
  // tripwire fires, a loss signal came in, or the belt-and-braces cadence is due.
  const shouldSweep = async (): Promise<boolean> => {
    const signature = await gitCommonDirectorySignature(worktreesDir)
    const tripwireFired = signature !== lastSignature
    lastSignature = signature
    ticksSinceSweep++
    if (pendingLossSweep || tripwireFired || ticksSinceSweep >= BELT_AND_BRACES_SWEEP_TICKS) {
      pendingLossSweep = false
      ticksSinceSweep = 0
      return true
    }
    return false
  }

  return {
    ensureStarted: async () => {
      if (subscription || !canStart()) {
        return
      }
      // Why: seed the tripwire baseline before the poller's own first tick so
      // that tick doesn't unconditionally treat "no prior observation" as change.
      lastSignature = await gitCommonDirectorySignature(worktreesDir)
      const reconciliation = await startGitCommonPolling(
        commonDirPath,
        (events) => {
          const rootWasReplaced =
            events.some((event) => event.type === 'delete' && event.path === worktreesDir) &&
            events.some((event) => event.type === 'create' && event.path === worktreesDir)
          // Why: this backstop lags the native stream by up to 15 ticks, so it
          // routinely reports entry creates the stream already delivered. Only
          // treat them as a replacement when the root itself was also recreated
          // — otherwise every ordinary `git worktree add` would tear down a
          // healthy stream and open a deaf window while it resubscribes.
          const rootRecreated = events.some(
            (event) => event.type === 'create' && event.path === worktreesDir
          )
          const coarseRootReplacement =
            rootRecreated &&
            events.some(
              (event) =>
                event.type === 'create' &&
                event.path !== worktreesDir &&
                dirname(event.path) === worktreesDir
            )
          if (rootWasReplaced || coarseRootReplacement) {
            onRootReplacement()
          }
          onEvents(
            coarseRootReplacement
              ? events.map((event) =>
                  event.type === 'update' && event.path === worktreesDir
                    ? { ...event, type: 'create' }
                    : event
                )
              : events
          )
        },
        pollIntervalMs * NARROW_WATCH_RECONCILIATION_TICKS,
        pollVisibility,
        undefined,
        false,
        () => [],
        { forceFullScanEveryTick: true, shouldSweep }
      )
      if (!shouldKeep()) {
        await reconciliation.unsubscribe()
      } else {
        subscription = reconciliation
      }
    },
    notifyWindowBecameVisible: () => {
      for (const listener of visibilityListeners) {
        listener()
      }
    },
    notifyLossSignal: () => {
      pendingLossSweep = true
    },
    unsubscribe: async () => {
      const current = subscription
      subscription = null
      await current?.unsubscribe()
    }
  }
}
