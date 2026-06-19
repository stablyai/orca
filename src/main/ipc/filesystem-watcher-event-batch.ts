import type { Event as WatcherEvent } from '@parcel/watcher'

export const MAX_BATCHED_WATCHER_EVENTS = 5_000

export type WatcherEventBatchState = {
  events: WatcherEvent[]
  overflowed: boolean
}

export function appendWatcherEvents(
  batchEvents: WatcherEvent[],
  incomingEvents: WatcherEvent[]
): void {
  // Why: worktree deletion can deliver enough events that `push(...events)`
  // exceeds V8's argument limit and crashes the main process.
  for (const event of incomingEvents) {
    batchEvents.push(event)
  }
}

export function queueWatcherEvents(
  batch: WatcherEventBatchState,
  incomingEvents: WatcherEvent[]
): void {
  if (batch.overflowed) {
    return
  }

  if (batch.events.length + incomingEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
    // Why: once precision is too expensive, keeping every path only burns
    // memory before flush sends the same conservative overflow refresh.
    batch.events = []
    batch.overflowed = true
    return
  }

  appendWatcherEvents(batch.events, incomingEvents)
}
