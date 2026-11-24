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
import { isOnNetworkVolume } from './worktree-git-common-network-volume'

// The native watcher is primary: reconcile its silent losses every five minutes and on window focus, not every 30 s.
const NARROW_WATCH_RECONCILIATION_TICKS = 150
// Each timed reconciliation sweeps every leaf, keeping the five-minute bound for coarse-timestamp filesystems.
const RECONCILIATION_FULL_SCAN_EVERY_TICKS = 1
// Focus and reveal scan at most as often as the old 30 s cadence, counting timed sweeps.
const ON_DEMAND_RECONCILIATION_MIN_TICKS = 15
// Network volumes can miss other hosts' changes silently, so they keep the old 30 s check with a five-minute full sweep.
const NETWORK_VOLUME_RECONCILIATION_TICKS = 15
const NETWORK_VOLUME_FULL_SCAN_EVERY_TICKS = 10

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
  let unsubscribeFocus: (() => void) | undefined
  const handleFocus = (): void => {
    subscription?.poke()
  }
  const starting = createSingleFlight()
  let onNetworkVolume: Promise<boolean> | null = null
  let generation = 0
  const visibilityListeners = new Set<() => void>()
  const pollVisibility: WorktreePollerWindowVisibility = {
    isWindowVisible: visibility.isWindowVisible,
    onWindowHidden: visibility.onWindowHidden,
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
        onNetworkVolume ??= isOnNetworkVolume(commonDirPath)
        const network = await onNetworkVolume
        const reconciliation = await startGitCommonPolling(
          commonDirPath,
          handleEvents,
          pollIntervalMs *
            (network ? NETWORK_VOLUME_RECONCILIATION_TICKS : NARROW_WATCH_RECONCILIATION_TICKS),
          pollVisibility,
          undefined,
          false,
          () => [],
          {
            reconciliationFullScanEveryTicks: network
              ? NETWORK_VOLUME_FULL_SCAN_EVERY_TICKS
              : RECONCILIATION_FULL_SCAN_EVERY_TICKS,
            minOnDemandScanIntervalMs: pollIntervalMs * ON_DEMAND_RECONCILIATION_MIN_TICKS,
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
          // Registered per subscription: a polling-fallback cycle restarts this object after unsubscribe.
          unsubscribeFocus ??= visibility.onWindowFocused?.(handleFocus)
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
      unsubscribeFocus = undefined
      generation++
      await starting.pending()?.catch(() => {})
      const current = subscription
      subscription = null
      await current?.unsubscribe()
    }
  }
}
