import { dirname, join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from '../creation/worktree-base-directory-poller'
import {
  startGitCommonPolling,
  type GitCommonPollingSubscription
} from './worktree-git-common-polling'
import { createSingleFlight } from './single-flight-promise'

// The native watcher is primary: reconcile its silent losses every five minutes and on window focus, not every 30 s.
const NARROW_WATCH_RECONCILIATION_TICKS = 150
// Each timed reconciliation sweeps every leaf, keeping the five-minute bound for coarse-timestamp filesystems.
const RECONCILIATION_FULL_SCAN_EVERY_TICKS = 1
// Focus runs the gated per-entry check at most as often as the old 30 s cadence.
const FOCUS_RECONCILIATION_MIN_TICKS = 15

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
  let lastFocusReconcileAt = 0
  const unsubscribeFocus = visibility.onWindowFocused?.(() => {
    const now = Date.now()
    if (
      !subscription ||
      now - lastFocusReconcileAt < pollIntervalMs * FOCUS_RECONCILIATION_MIN_TICKS
    ) {
      return
    }
    lastFocusReconcileAt = now
    subscription.poke()
  })
  const starting = createSingleFlight()
  let generation = 0
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

  const handleEvents = (events: WorktreeBasePollEvent[]): void => {
    const rootDeleted = events.some(
      (event) => event.type === 'delete' && event.path === worktreesDir
    )
    // Ordinary child creates repeat native events; delayed root loss may conservatively rearm a fresh stream.
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
    if (rootDeleted || coarseRootReplacement) {
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
  }

  return {
    ensureStarted: () => {
      if (subscription || !canStart()) {
        return Promise.resolve()
      }
      return starting.run(async () => {
        const startGeneration = generation
        const shouldKeepBaseline = (): boolean => startGeneration === generation && shouldKeep()
        const reconciliation = await startGitCommonPolling(
          commonDirPath,
          handleEvents,
          pollIntervalMs * NARROW_WATCH_RECONCILIATION_TICKS,
          pollVisibility,
          undefined,
          false,
          () => [],
          {
            reconciliationFullScanEveryTicks: RECONCILIATION_FULL_SCAN_EVERY_TICKS,
            onRootMissing: (initial) => {
              if (shouldKeepBaseline()) {
                if (initial) {
                  handleEvents([{ type: 'delete', path: worktreesDir }])
                } else {
                  onRootReplacement()
                }
              }
            }
          }
        )
        if (!shouldKeepBaseline()) {
          await reconciliation.unsubscribe()
        } else {
          subscription = reconciliation
        }
      })
    },
    notifyWindowBecameVisible: () => {
      for (const listener of visibilityListeners) {
        listener()
      }
    },
    unsubscribe: async () => {
      unsubscribeFocus?.()
      generation++
      await starting.pending()?.catch(() => {})
      const current = subscription
      subscription = null
      await current?.unsubscribe()
    }
  }
}
