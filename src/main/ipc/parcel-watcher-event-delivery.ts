import { stat } from 'node:fs/promises'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import { MAX_BATCHED_WATCHER_EVENTS } from './filesystem-watcher-event-batch'
import type {
  WatcherProcessDeliveryOptions,
  WatcherProcessEvent
} from './parcel-watcher-process-protocol'

const DIRECTORY_STAT_CONCURRENCY = 8
let activeDirectoryStats = 0
const directoryStatWaiters: (() => void)[] = []

export type WatcherProcessEventDeliveryQueue = {
  enqueue(events: readonly ParcelWatcherEvent[]): void
  close(): void
}

async function acquireDirectoryStatSlot(): Promise<void> {
  if (activeDirectoryStats < DIRECTORY_STAT_CONCURRENCY) {
    activeDirectoryStats++
    return
  }
  await new Promise<void>((resolve) => directoryStatWaiters.push(resolve))
}

function releaseDirectoryStatSlot(): void {
  const next = directoryStatWaiters.shift()
  if (next) {
    // Transfer the existing slot directly so a newly arriving task cannot
    // overtake this waiter and temporarily exceed the global budget.
    next()
    return
  }
  activeDirectoryStats--
}

async function statWatcherEventPath(eventPath: string): Promise<boolean> {
  await acquireDirectoryStatSlot()
  try {
    return (await stat(eventPath)).isDirectory()
  } finally {
    releaseDirectoryStatSlot()
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let cursor = 0
  const lane = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

async function mapWatcherEvent(
  event: ParcelWatcherEvent,
  includeDirectoryMetadata: boolean
): Promise<WatcherProcessEvent> {
  if (!includeDirectoryMetadata || event.type === 'delete') {
    return { type: event.type, path: event.path }
  }
  let isDirectory = false
  try {
    isDirectory = await statWatcherEventPath(event.path)
  } catch {
    // Why: a path can vanish between the native event and metadata lookup.
    // Treat unknown metadata as a file-like event so parent invalidation still runs.
  }
  return { type: event.type, path: event.path, isDirectory }
}

export async function prepareWatcherProcessEvents(
  events: readonly ParcelWatcherEvent[],
  delivery: WatcherProcessDeliveryOptions | undefined
): Promise<WatcherProcessEvent[] | null> {
  if (delivery?.maxEventsPerBatch !== undefined && events.length > delivery.maxEventsPerBatch) {
    return null
  }
  if (delivery?.includeDirectoryMetadata !== true) {
    return events.map((event) => ({ type: event.type, path: event.path }))
  }
  return mapWithConcurrency(events, DIRECTORY_STAT_CONCURRENCY, (event) =>
    mapWatcherEvent(event, true)
  )
}

/** Keep at most one active and one bounded pending batch per subscription. */
export function createWatcherProcessEventDeliveryQueue(
  delivery: WatcherProcessDeliveryOptions | undefined,
  deliver: (events: WatcherProcessEvent[] | null) => Promise<void>,
  onError: (error: unknown) => void
): WatcherProcessEventDeliveryQueue {
  const eventLimit = delivery?.maxEventsPerBatch ?? MAX_BATCHED_WATCHER_EVENTS
  let active = true
  let draining = false
  let pendingOverflow = false
  let pendingEvents: ParcelWatcherEvent[] = []

  const drain = async (): Promise<void> => {
    if (!active || draining) {
      return
    }
    draining = true
    try {
      while (active && (pendingOverflow || pendingEvents.length > 0)) {
        const overflowed = pendingOverflow
        const events = pendingEvents
        pendingOverflow = false
        pendingEvents = []
        if (overflowed) {
          await deliver(null)
          continue
        }
        const prepared = await prepareWatcherProcessEvents(events, delivery)
        if (active) {
          await deliver(prepared)
        }
      }
    } catch (error) {
      if (active) {
        onError(error)
      }
    } finally {
      draining = false
      if (active && (pendingOverflow || pendingEvents.length > 0)) {
        void drain()
      }
    }
  }

  return {
    enqueue(events): void {
      if (!active || events.length === 0 || pendingOverflow) {
        return
      }
      if (events.length > eventLimit || pendingEvents.length + events.length > eventLimit) {
        pendingEvents = []
        pendingOverflow = true
      } else {
        for (const event of events) {
          pendingEvents.push(event)
        }
      }
      void drain()
    },
    close(): void {
      active = false
      pendingEvents = []
      pendingOverflow = false
    }
  }
}
