import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type { WatcherProcessSubscription } from './parcel-watcher-process-subscription'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { createSingleFlight } from './single-flight-promise'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import { startGitCommonPrimaryPolling } from './worktree-git-common-primary-polling'

const PRIMARY_WATCH_OPTIONS = {
  mode: 'shallow' as const,
  include: PRIMARY_CHECKOUT_METADATA_FILES
}

// Why: the shallow watcher can stop reporting without ever erroring — a lossy
// notification path (network mount, inotify queue overflow in the shared child),
// a dropped event batch, or a binding that went deaf between rebind sweeps. None
// of those raise, so the error-driven fallback never fires. A bounded re-stat is
// the only thing that turns "silently stale forever" into "stale for one tick".
// At 15 ticks this is ~0.2 stats/s/repo against the 3/s the old poll cost.
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
        // `statusRefPolling` deliberately excluded: it covers only status refs,
        // so its presence is not evidence that primary metadata is covered.
        if (disposed || watcher) {
          await nextFallback.unsubscribe()
          return
        }
        void stopWatcherSidePolling()
        fallback = nextFallback
      })
    )

  const stopWatcherSidePolling = async (): Promise<void> => {
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
      const [nextStatusRefPolling, nextBackstop] = await Promise.all([
        startGitCommonPrimaryPolling(
          commonDirPath,
          getStatusRefPaths,
          onEvents,
          pollIntervalMs,
          visibility,
          undefined,
          false
        ),
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
      // Why: a terminal watch error can land while the two polls above are still
      // starting. handleWatcherError already ran its teardown against nulls, so
      // adopting these now would strand the repo with status-ref coverage only.
      if (disposed || !watcher) {
        await Promise.all([
          nextStatusRefPolling.unsubscribe().catch(() => {}),
          nextBackstop.unsubscribe().catch(() => {})
        ])
        if (!disposed) {
          await startFallback()
        }
      } else {
        statusRefPolling = nextStatusRefPolling
        backstopPolling = nextBackstop
      }
    }
  } catch (error) {
    handleWatcherError(error instanceof Error ? error : new Error(String(error)))
  }

  return {
    unsubscribe: async () => {
      disposed = true
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
