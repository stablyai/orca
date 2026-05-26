import { describe, expect, it } from 'vitest'
import type { Event as WatcherEvent } from '@parcel/watcher'
import {
  MAX_BATCHED_WATCHER_EVENTS,
  queueWatcherEvents,
  type WatcherEventBatchState
} from './filesystem-watcher-event-batch'

describe('queueWatcherEvents', () => {
  function events(count: number): WatcherEvent[] {
    return Array.from(
      { length: count },
      (_, index): WatcherEvent => ({ type: 'update', path: `/repo/file-${index}.ts` })
    )
  }

  it('keeps precise events while the batch remains under the overflow limit', () => {
    const batch: WatcherEventBatchState = { events: [], overflowed: false }

    queueWatcherEvents(batch, events(2))

    expect(batch.overflowed).toBe(false)
    expect(batch.events.map((event) => event.path)).toEqual(['/repo/file-0.ts', '/repo/file-1.ts'])
  })

  it('marks overflow without retaining oversized event lists', () => {
    const batch: WatcherEventBatchState = { events: events(2), overflowed: false }

    queueWatcherEvents(batch, events(MAX_BATCHED_WATCHER_EVENTS))
    queueWatcherEvents(batch, events(1))

    expect(batch.overflowed).toBe(true)
    expect(batch.events).toHaveLength(0)
  })
})
