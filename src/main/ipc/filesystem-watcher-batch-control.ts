import type { Event as WatcherEvent } from '@parcel/watcher'
import type { WatchedRoot } from './filesystem-watcher-wsl'

export type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
  flushInFlight: boolean
  flushQueued: boolean
  cancelled: boolean
}

export function createDebouncedBatch(): DebouncedBatch {
  return {
    events: [],
    overflowed: false,
    timer: null,
    firstEventAt: 0,
    flushInFlight: false,
    flushQueued: false,
    cancelled: false
  }
}

/** Cancel pending and queued flush work when a root is torn down. */
export function cancelLocalBatchFlush(root: WatchedRoot): void {
  root.batch.cancelled = true
  root.batch.flushQueued = false
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  root.batch.events = []
  root.batch.overflowed = false
  root.batch.firstEventAt = 0
}
