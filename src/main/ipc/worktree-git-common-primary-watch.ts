import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './filesystem/watcher-process/parcel-watcher-process'
import type { WatcherProcessSubscription } from './filesystem/watcher-process/parcel-watcher-process-subscription'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { createSingleFlight } from './single-flight-promise'
import { onActiveGitStatusRefBindingChanged } from './worktree-git-status-ref-watch'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import { startGitCommonPrimaryPolling } from './worktree-git-common-primary-polling'

const PRIMARY_WATCH_OPTIONS = {
  mode: 'shallow' as const,
  include: PRIMARY_CHECKOUT_METADATA_FILES
}

// Native watches can silently lose events; bounded re-stat catches stale primary metadata without full polling cost.
const PRIMARY_BACKSTOP_TICKS = 15

function primaryMetadataEvents(commonDirPath: string): WorktreeBasePollEvent[] {
  return PRIMARY_CHECKOUT_METADATA_FILES.map((name) => ({
    type: 'update',
    path: join(commonDirPath, name)
  }))
}

export async function startGitCommonPrimaryWatch(
  commonDirPath: string,
  getStatusRefPaths: () => readonly string[],
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let watcher: WatcherProcessSubscription | null = null
  let statusRefPolling: WorktreeBaseSubscription | null = null
  // Concurrent start/rebind attempts need generations so losing pollers release their timers and visibility listeners.
  let statusRefGeneration = 0
  let backstopPolling: WorktreeBaseSubscription | null = null
  let fallback: WorktreeBaseSubscription | null = null
  const fallbackFlight = createSingleFlight()

  const startFallback = (): Promise<void> =>
    fallbackFlight.run(() =>
      startGitCommonPrimaryPolling(
        commonDirPath,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan
      ).then(async (nextFallback) => {
        // Status-ref polling does not cover primary metadata.
        if (disposed || watcher) {
          await nextFallback.unsubscribe()
          return
        }
        void stopWatcherSidePolling()
        fallback = nextFallback
      })
    )

  const startStatusRefPollingIfSelected = async (): Promise<WorktreeBaseSubscription | null> =>
    getStatusRefPaths().length === 0
      ? null
      : startGitCommonPrimaryPolling(
          commonDirPath,
          getStatusRefPaths,
          onEvents,
          pollIntervalMs,
          visibility,
          undefined,
          false
        )

  // Synchronous binding events avoid idle polling; only the current generation may adopt a newly built poller.
  const adoptStatusRefPolling = async (
    generation: number,
    next: WorktreeBaseSubscription | null
  ): Promise<void> => {
    if (!next) {
      return
    }
    if (
      generation !== statusRefGeneration ||
      disposed ||
      !watcher ||
      statusRefPolling ||
      getStatusRefPaths().length === 0
    ) {
      await next.unsubscribe().catch(() => {})
      return
    }
    statusRefPolling = next
  }

  const syncStatusRefPolling = async (): Promise<void> => {
    if (disposed || !watcher) {
      return
    }
    const generation = ++statusRefGeneration
    const selected = getStatusRefPaths().length > 0
    if (selected === (statusRefPolling !== null)) {
      return
    }
    if (!selected) {
      const current = statusRefPolling
      statusRefPolling = null
      await current?.unsubscribe().catch(() => {})
      return
    }
    await adoptStatusRefPolling(generation, await startStatusRefPollingIfSelected())
  }

  const unsubscribeBindingChanges = onActiveGitStatusRefBindingChanged(() => {
    void syncStatusRefPolling().catch(() => {})
  })

  const stopWatcherSidePolling = async (): Promise<void> => {
    statusRefGeneration++
    const current = statusRefPolling
    const currentBackstop = backstopPolling
    statusRefPolling = null
    backstopPolling = null
    await Promise.all([
      current?.unsubscribe().catch(() => {}),
      currentBackstop?.unsubscribe().catch(() => {})
    ])
  }

  const handleWatcherError = (error: Error): void => {
    if (disposed) {
      return
    }
    onWatchError?.(error)
    if (!onWatchError) {
      onEvents(primaryMetadataEvents(commonDirPath))
    }
    const current = watcher
    watcher = null
    if (current) {
      void current.unsubscribe().catch(() => {})
    }
    void stopWatcherSidePolling()
      .then(() => startFallback())
      .catch(() => {})
  }

  try {
    watcher = await subscribeViaWatcherProcess(
      commonDirPath,
      (error, events) => {
        if (error) {
          handleWatcherError(error)
          return
        }
        if (events.length > 0) {
          onEvents(events.map((event) => ({ type: event.type, path: event.path })))
        }
      },
      PRIMARY_WATCH_OPTIONS,
      {
        onInterruption: () => {
          if (!disposed) {
            const error = new Error('Git primary metadata watcher interrupted')
            if (onWatchError) {
              onWatchError(error)
            } else {
              onEvents(primaryMetadataEvents(commonDirPath))
            }
          }
        }
      }
    )
    if (watcher && !disposed && !fallbackFlight.pending()) {
      const generation = ++statusRefGeneration
      const [nextStatusRefPolling, nextBackstop] = await Promise.all([
        startStatusRefPollingIfSelected(),
        startGitCommonPrimaryPolling(
          commonDirPath,
          () => [],
          onEvents,
          pollIntervalMs * PRIMARY_BACKSTOP_TICKS,
          visibility,
          undefined,
          true
        )
      ])
      // A terminal watch error can finish teardown before starting polls settle; refuse late adoption.
      if (disposed || !watcher) {
        await Promise.all([
          nextStatusRefPolling?.unsubscribe().catch(() => {}),
          nextBackstop.unsubscribe().catch(() => {})
        ])
        if (!disposed) {
          await startFallback()
        }
      } else {
        await adoptStatusRefPolling(generation, nextStatusRefPolling)
        backstopPolling = nextBackstop
      }
    }
  } catch (error) {
    handleWatcherError(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    unsubscribe: async () => {
      disposed = true
      unsubscribeBindingChanges()
      const current = watcher
      watcher = null
      if (current) {
        await current.unsubscribe().catch(() => {})
      }
      await stopWatcherSidePolling()
      await fallbackFlight.pending()?.catch(() => {})
      if (fallback) {
        await fallback.unsubscribe().catch(() => {})
        fallback = null
      }
    }
  }
}
