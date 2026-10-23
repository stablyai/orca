import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import type { ShallowWatcherSubscription } from './parcel-watcher-shallow-subscription'
import { watchFileAcrossReplacement, type RebindingFileWatch } from './rebinding-file-watch'

// Why: bindings that missed a replacement are found by this sweep. Primary git
// metadata also has its own backstop poll, so this bounds staleness, not latency.
const REBIND_SWEEP_INTERVAL_MS = 30_000
// Why: a file created later with no sibling write (packed-refs from pack-refs or
// gc) is only found by a sweep. Re-statting just the missing paths is one ENOENT
// each, so they get the git poll cadence instead of waiting for the full sweep.
export const MISSING_FILE_SWEEP_INTERVAL_MS = 2_000

/** One watch per included file, so a `.git` root never streams objects/, refs/
 *  or worktrees/ churn. Used on macOS, where a directory watch is recursive. */
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
          // Git writes these files together, so one event is a cheap moment to
          // look for a sibling that has just been created.
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
