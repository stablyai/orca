import type { Event as WatcherEvent } from '@parcel/watcher'

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
