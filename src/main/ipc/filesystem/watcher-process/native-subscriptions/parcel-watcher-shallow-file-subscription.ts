import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import type { ShallowWatcherSubscription } from './parcel-watcher-shallow-subscription'
import { watchFileAcrossReplacement, type RebindingFileWatch } from './rebinding-file-watch'

// Rebind missed replacements; Git metadata polling provides the shorter staleness backstop.
const REBIND_SWEEP_INTERVAL_MS = 30_000
// Newly created files may have no sibling event; check only missing paths at the Git poll cadence.
export const MISSING_FILE_SWEEP_INTERVAL_MS = 2_000

/** Watch files individually on macOS to avoid recursive .git object/ref/worktree churn. */
export function startShallowFileWatcher(
  rootPath: string,
  relativePaths: readonly string[],
  onEvents: (events: ParcelWatcherEvent[]) => void,
  onError: (error: Error) => void
): ShallowWatcherSubscription {
  let disposed = false
  let reportedError = false
  const reportError = (error: unknown): void => {
    if (disposed || reportedError) {
      return
    }
    reportedError = true
    onError(error instanceof Error ? error : new Error(String(error)))
  }

  try {
    if (!statSync(rootPath).isDirectory()) {
      throw new Error(`Shallow watcher root is not a directory: ${rootPath}`)
    }
  } catch (error) {
    reportError(error)
  }

  const emitUpdate = (path: string): void => {
    if (!disposed) {
      onEvents([{ type: 'update', path }])
    }
  }

  const watches = new Map<string, RebindingFileWatch>()
  const refreshAll = (onlyUnbound: boolean): void => {
    for (const fileWatch of watches.values()) {
      if (!onlyUnbound || !fileWatch.isBound()) {
        void fileWatch.refresh()
      }
    }
  }

  const paths = new Set(
    relativePaths
      .map((relativePath) =>
        relativePath.split(process.platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean)
      )
      .filter((parts) => parts.length > 0)
      .map((parts) => join(rootPath, ...parts))
  )
  for (const path of paths) {
    watches.set(
      path,
      watchFileAcrossReplacement(
        path,
        () => {
          emitUpdate(path)
          // Git writes sibling metadata together; use the event to discover newly created files.
          refreshAll(true)
        },
        reportError
      )
    )
  }

  const sweepTimer = setInterval(() => {
    if (!disposed) {
      refreshAll(false)
    }
  }, REBIND_SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
  const missingFileTimer = setInterval(() => {
    if (!disposed) {
      refreshAll(true)
    }
  }, MISSING_FILE_SWEEP_INTERVAL_MS)
  missingFileTimer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      clearInterval(sweepTimer)
      clearInterval(missingFileTimer)
      await Promise.all([...watches.values()].map((fileWatch) => fileWatch.close()))
    }
  }
}
