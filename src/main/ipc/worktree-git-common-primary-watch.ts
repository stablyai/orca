import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type { WatcherProcessSubscription } from './parcel-watcher-process-subscription'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-polling'
import { startGitCommonPrimaryPolling } from './worktree-git-common-primary-polling'

const PRIMARY_WATCH_OPTIONS = {
  mode: 'shallow' as const,
  include: PRIMARY_CHECKOUT_METADATA_FILES
}

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
  let fallback: WorktreeBaseSubscription | null = null
  let fallbackPromise: Promise<void> | null = null

  const startFallback = (): Promise<void> => {
    if (fallbackPromise) {
      return fallbackPromise
    }
    const pending = startGitCommonPrimaryPolling(
      commonDirPath,
      getStatusRefPaths,
      onEvents,
      pollIntervalMs,
      visibility,
      onFullScan
    ).then(async (nextFallback) => {
      if (disposed || watcher || statusRefPolling) {
        await nextFallback.unsubscribe()
        return
      }
      fallback = nextFallback
    })
    const tracked = pending.finally(() => {
      if (fallbackPromise === tracked) {
        fallbackPromise = null
      }
    })
    fallbackPromise = tracked
    return fallbackPromise
  }

  const stopStatusRefPolling = async (): Promise<void> => {
    const current = statusRefPolling
    statusRefPolling = null
    if (current) {
      await current.unsubscribe().catch(() => {})
    }
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
    void stopStatusRefPolling()
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
    if (watcher && !disposed && !fallbackPromise) {
      statusRefPolling = await startGitCommonPrimaryPolling(
        commonDirPath,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        undefined,
        false
      )
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
      await stopStatusRefPolling()
      await fallbackPromise?.catch(() => {})
      if (fallback) {
        await fallback.unsubscribe().catch(() => {})
        fallback = null
      }
    }
  }
}
