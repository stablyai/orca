import { stat } from 'node:fs/promises'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import { MAX_BATCHED_WATCHER_EVENTS } from './filesystem-watcher-event-batch'
import type {
  WatcherProcessDeliveryOptions,
  WatcherProcessEvent
} from './parcel-watcher-process-protocol'

const DIRECTORY_STAT_CONCURRENCY = 8
const directoryStatSlots = new PrioritySemaphore(DIRECTORY_STAT_CONCURRENCY)

export type WatcherProcessEventDeliveryQueue = {
  enqueue(events: readonly ParcelWatcherEvent[]): void
  close(): void
}

async function statWatcherEventPath(eventPath: string, signal?: AbortSignal): Promise<boolean> {
  const release = await directoryStatSlots.acquire(0, signal)
  try {
    signal?.throwIfAborted()
    return (await stat(eventPath)).isDirectory()
  } finally {
    release()
  }
}

async function mapWatcherEvent(
  event: ParcelWatcherEvent,
  includeDirectoryMetadata: boolean,
  signal?: AbortSignal
): Promise<WatcherProcessEvent> {
  signal?.throwIfAborted()
  if (!includeDirectoryMetadata || event.type === 'delete') {
    return { type: event.type, path: event.path }
  }
  let isDirectory = false
  try {
    isDirectory = await statWatcherEventPath(event.path, signal)
  } catch {
    signal?.throwIfAborted()
    // Why: a path can vanish between the native event and metadata lookup.
    // Treat unknown metadata as a file-like event so parent invalidation still runs.
  }
  return { type: event.type, path: event.path, isDirectory }
}

export async function prepareWatcherProcessEvents(
  events: readonly ParcelWatcherEvent[],
  delivery: WatcherProcessDeliveryOptions | undefined,
  signal?: AbortSignal
): Promise<WatcherProcessEvent[] | null> {
  signal?.throwIfAborted()
  if (delivery?.maxEventsPerBatch !== undefined && events.length > delivery.maxEventsPerBatch) {
    return null
  }
  if (delivery?.includeDirectoryMetadata !== true) {
    return events.map((event) => ({ type: event.type, path: event.path }))
  }
  return mapWithConcurrency(events, DIRECTORY_STAT_CONCURRENCY, (event) =>
    mapWatcherEvent(event, true, signal)
  )
}

/** Keep at most one active and one bounded pending batch per subscription. */
export function createWatcherProcessEventDeliveryQueue(
  delivery: WatcherProcessDeliveryOptions | undefined,
  deliver: (events: WatcherProcessEvent[] | null) => Promise<void>,
  onError: (error: unknown) => void
): WatcherProcessEventDeliveryQueue {
  const eventLimit = delivery?.maxEventsPerBatch ?? MAX_BATCHED_WATCHER_EVENTS
  const controller = new AbortController()
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
        const prepared = await prepareWatcherProcessEvents(events, delivery, controller.signal)
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
      controller.abort()
      pendingEvents = []
      pendingOverflow = false
    }
  }
}
