import { describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ stat: statMock }))

import { createWatcherProcessEventDeliveryQueue } from './parcel-watcher-event-delivery'

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
    const deliver = vi.fn(() => blocked.promise)
    const queue = createWatcherProcessEventDeliveryQueue({}, deliver, vi.fn())
    queue.enqueue([{ type: 'update', path: '/repo/file' }])
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    const first = queue.flush()
    const second = queue.flush()
    expect(second).toBe(first)
    const settled = vi.fn()
    void first.then(settled)
    queue.close()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toBeUndefined()
    await expect(queue.flush()).resolves.toBeUndefined()
    blocked.resolve()
  })
})
