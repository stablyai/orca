import { setImmediate } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ stat: statMock }))

import {
  createWatcherProcessEventDeliveryQueue,
  prepareWatcherProcessEvents
} from './parcel-watcher-event-delivery'

describe('prepareWatcherProcessEvents', () => {
  beforeEach(() => {
    statMock.mockReset()
  })

  it('caps directory metadata stat work across concurrent roots in one child', async () => {
    let activeStats = 0
    let maxActiveStats = 0
    statMock.mockImplementation(async () => {
      activeStats++
      maxActiveStats = Math.max(maxActiveStats, activeStats)
      await setImmediate()
      activeStats--
      return { isDirectory: () => false }
    })
    const batches = Array.from({ length: 8 }, (_, rootIndex) =>
      Array.from({ length: 16 }, (_, eventIndex) => ({
        type: 'update' as const,
        path: `/repo-${rootIndex}/file-${eventIndex}.ts`
      }))
    )

    await Promise.all(
      batches.map((events) =>
        prepareWatcherProcessEvents(events, {
          includeDirectoryMetadata: true,
          maxEventsPerBatch: 200
        })
      )
    )

    expect(statMock).toHaveBeenCalledTimes(128)
    expect(maxActiveStats).toBe(8)
  })
})

describe('watcher event queue flush', () => {
  it('waits for active delivery and the bounded pending overflow', async () => {
    const firstDelivery = Promise.withResolvers<void>()
    const deliver = vi
      .fn()
      .mockImplementationOnce(() => firstDelivery.promise)
      .mockResolvedValue(undefined)
    const queue = createWatcherProcessEventDeliveryQueue({ maxEventsPerBatch: 1 }, deliver, vi.fn())
    queue.enqueue([{ type: 'update', path: '/repo/first' }])
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    queue.enqueue([
      { type: 'delete', path: '/repo/child' },
      { type: 'delete', path: '/repo' }
    ])
    let flushed = false
    const pending = queue.flush().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(false)
    firstDelivery.resolve()
    await pending
    expect(deliver.mock.calls.map(([events]) => events)).toEqual([
      [{ type: 'update', path: '/repo/first' }],
      null
    ])
    await expect(queue.flush()).resolves.toBeUndefined()
    queue.close()
  })

  it('settles all flush callers when closed while delivery is blocked', async () => {
    const blocked = Promise.withResolvers<void>()
    const queue = createWatcherProcessEventDeliveryQueue({}, () => blocked.promise, vi.fn())
    queue.enqueue([{ type: 'update', path: '/repo/file' }])
    const first = queue.flush()
    const second = queue.flush()
    expect(second).toBe(first)
    queue.close()
    await expect(first).resolves.toBeUndefined()
    await expect(queue.flush()).resolves.toBeUndefined()
    blocked.resolve()
  })

  it('settles flush after reporting a delivery error', async () => {
    const onError = vi.fn()
    const failure = new Error('delivery failed')
    const queue = createWatcherProcessEventDeliveryQueue(
      {},
      async () => {
        throw failure
      },
      onError
    )
    queue.enqueue([{ type: 'update', path: '/repo/file' }])
    await queue.flush()
    expect(onError).toHaveBeenCalledWith(failure)
    queue.close()
  })
})
