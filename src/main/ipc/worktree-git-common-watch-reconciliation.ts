import { dirname, join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonPolling } from './worktree-git-common-polling'
import { createSingleFlight } from './single-flight-promise'

// Reconcile silent native losses on the shared 15-tick backstop without per-repo two-second timers.
const NARROW_WATCH_RECONCILIATION_TICKS = 15
// Gate each reconciliation by directory/in-place signatures; sweep every leaf about every five minutes.
const RECONCILIATION_FULL_SCAN_EVERY_TICKS = 10

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
  let subscription: WorktreeBaseSubscription | null = null
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

  return {
    ensureStarted: () => {
      if (subscription || !canStart()) {
        return Promise.resolve()
      }
      return starting.run(async () => {
        const startGeneration = generation
        const reconciliation = await startGitCommonPolling(
          commonDirPath,
          (events) => {
            const rootWasReplaced =
              events.some((event) => event.type === 'delete' && event.path === worktreesDir) &&
              events.some((event) => event.type === 'create' && event.path === worktreesDir)
            // Delayed reconciliation repeats native creates; only recreated roots justify replacing the healthy stream.
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
          { reconciliationFullScanEveryTicks: RECONCILIATION_FULL_SCAN_EVERY_TICKS }
        )
        if (startGeneration !== generation || !shouldKeep()) {
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
      generation++
      await starting.pending()?.catch(() => {})
      const current = subscription
      subscription = null
      await current?.unsubscribe()
    }
  }
}
