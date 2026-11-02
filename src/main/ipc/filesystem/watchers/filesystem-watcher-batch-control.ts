import type { Event as WatcherEvent } from '@parcel/watcher'
import type { WatchedRoot } from './filesystem-watcher-wsl'

export type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
  flushInFlight: boolean
  flushQueued: boolean
  cancelled: boolean
  statAbortController: AbortController
}

export function createDebouncedBatch(): DebouncedBatch {
  return {
    events: [],
    overflowed: false,
    timer: null,
    lastFlushAt: 0,
    flushInFlight: false,
    flushQueued: false,
    cancelled: false,
    statAbortController: new AbortController()
  }
}

export function cancelLocalBatchFlush(root: WatchedRoot): void {
  root.batch.cancelled = true
  root.batch.statAbortController.abort()
  root.batch.flushQueued = false
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  root.batch.events = []
  root.batch.overflowed = false
}
