import { dirname, join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import {
  startGitCommonPolling,
  type GitCommonPollingSubscription
} from './worktree-git-common-polling'

// The native stream is still the fast path. A scheduled 15-tick reconciliation
// bounds silent watcher loss at the existing 30-second backstop without joining
// the per-repo 2-second timer fleet.
const NARROW_WATCH_RECONCILIATION_TICKS = 15

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
   *  since then can't be trusted — request an early tick so the (always-on,
   *  per-entry-gated) sweep runs sooner than the regular 30s cadence, rather
   *  than gating whether it runs at all. */
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
  let subscription: GitCommonPollingSubscription | null = null
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

  return {
    ensureStarted: async () => {
      if (subscription || !canStart()) {
        return
      }
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
        // Why: #17839 made an unchanged entry's own per-entry stat gate (in
        // snapshotGitCommonEntry) the cheap path, so this backstop no longer
        // needs an outer sweep-skipping gate to stay affordable at fleet scale
        // — every regular tick can just run. earlyTickMinIntervalMs bounds
        // notifyLossSignal's requestEarlyTick to the same cadence the primary
        // git-common poller (WORKTREE_BASE_POLL_INTERVAL_MS) already runs a
        // full sweep at unconditionally, so a loss-signal storm can't drive
        // this backstop's fan-out faster than a rate already proven cheap.
        { earlyTickMinIntervalMs: pollIntervalMs }
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
      subscription?.requestEarlyTick()
    },
    unsubscribe: async () => {
      const current = subscription
      subscription = null
      await current?.unsubscribe()
    }
  }
}
