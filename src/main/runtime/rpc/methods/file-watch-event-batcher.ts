import { watchBatchFlushDelayMs } from '../../../../shared/filesystem-watch-batch-window'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { FileWatchEventBuffer } from '../../../../shared/filesystem-watch-event-buffer'
import type { FileWatchBatchCadence } from '../../../../shared/rpc-contract/files-target-params'

// Older clients discard superseded reads; 100ms batches starve slow links, so preserve their trailing window unless opted in.
const LEGACY_WATCH_BATCH_TRAILING_MS = 150
const LEGACY_WATCH_BATCH_MAX_WAIT_MS = 500

export function createFileWatchEventBatcher(
  worktree: string,
  emit: (result: unknown) => void,
  cadence?: FileWatchBatchCadence
): {
  push: (events: FsChangeEvent[]) => void
  flush: () => void
  dispose: () => void
} {
  const events = new FileWatchEventBuffer()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = 0
  let firstEventAt = 0

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    const nextEvents = events.take()
    firstEventAt = 0
    if (nextEvents.length === 0) {
      return
    }
    lastFlushAt = Date.now()
    emit({ type: 'changed', worktree, events: nextEvents })
  }

  return {
    push(nextEvents: FsChangeEvent[]): void {
      if (nextEvents.length === 0) {
        return
      }
      events.push(nextEvents)
      if (cadence !== 'interval') {
        const now = Date.now()
        firstEventAt ||= now
        if (now - firstEventAt >= LEGACY_WATCH_BATCH_MAX_WAIT_MS) {
          flush()
          return
        }
        clearTimer()
        timer = setTimeout(flush, LEGACY_WATCH_BATCH_TRAILING_MS)
        timer.unref?.()
        return
      }
      // Never postpone an armed flush; continuous writes must not starve delivery.
      if (timer) {
        return
      }
      timer = setTimeout(flush, watchBatchFlushDelayMs(Date.now(), lastFlushAt))
      timer.unref?.()
    },
    flush,
    dispose(): void {
      clearTimer()
      events.clear()
      firstEventAt = 0
    }
  }
}
