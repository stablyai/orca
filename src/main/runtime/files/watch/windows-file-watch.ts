import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { PhysicalExitTracker } from '../../../../shared/physical-exit-tracker'
import { watch as watchFs } from 'node:fs'
import { WatcherProcessFailure } from '../../../ipc/filesystem/watcher-process/parcel-watcher-process-failure'
import { watchBatchFlushDelayMs } from '../../../../shared/filesystem-watch-batch-window'

// Why: each emit is a whole-tree overflow refresh, so pace it slower than precise watcher batches.
export const WINDOWS_RUNTIME_FILE_WATCH_REFRESH_MS = 500
// Why: a one-off save after a quiet period still refreshes promptly.
export const WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS = 150
export const WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS = 10_000

export function watchWindowsRuntimeFileExplorer(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void,
  onTerminalError: (error: Error) => void
): () => Promise<void> {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastEmitAt = 0
  let closeStarted = false
  const physicalClose = new PhysicalExitTracker()

  const emitOverflow = (): void => {
    timer = null
    if (disposed) {
      return
    }
    lastEmitAt = Date.now()
    callback([{ kind: 'overflow', absolutePath: rootPath }])
  }

  const scheduleOverflow = (): void => {
    if (disposed) {
      return
    }
    // Why: never push an armed refresh back; a resetting debounce never fires under sustained writes.
    if (timer) {
      return
    }
    timer = setTimeout(
      emitOverflow,
      watchBatchFlushDelayMs(
        Date.now(),
        lastEmitAt,
        WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS,
        WINDOWS_RUNTIME_FILE_WATCH_REFRESH_MS
      )
    )
  }

  // Why: Parcel's Watchman probe can crash the headless server on Windows; use a conservative overflow refresh instead.
  const watcher = watchFs(rootPath, { recursive: true }, scheduleOverflow)
  const onClose = (): void => {
    watcher.removeListener('error', onError)
    physicalClose.markExited()
  }
  const onError = (err: Error): void => {
    console.error('[runtime-files.watch] Windows watcher error', { rootPath, err })
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    watcher.removeListener('close', onClose)
    watcher.removeListener('error', onError)
    // Why: Node nulls FSWatcher's native handle on error without a close event; treat the error as physical-exit proof.
    physicalClose.markExited()
    if (!disposed) {
      try {
        callback([{ kind: 'overflow', absolutePath: rootPath }])
      } finally {
        onTerminalError(err)
      }
    }
  }
  watcher.once('close', onClose)
  watcher.on('error', onError)

  return async () => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!closeStarted) {
      try {
        watcher.close()
      } catch (err) {
        console.error('[runtime-files.watch] Windows watcher close error', { rootPath, err })
        throw err
      }
      closeStarted = true
    }
    try {
      await physicalClose.waitForExit(
        WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
        () => new Error('Windows watcher did not close before deletion deadline')
      )
    } catch (error) {
      // Why: late Windows close still owns native dir handles; expose its completion so cleanup retains then clears the root.
      throw new WatcherProcessFailure(
        error instanceof Error ? error.message : String(error),
        'supervisor',
        'process_unavailable',
        physicalClose.exitedPromise
      )
    }
  }
}
