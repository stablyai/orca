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
  // Deletion storms can exceed V8's argument limit if spread into push.
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
    // Once overflow requires a conservative refresh, retaining individual paths only wastes memory.
    batch.events = []
    batch.overflowed = true
    return
  }

  appendWatcherEvents(batch.events, incomingEvents)
}
