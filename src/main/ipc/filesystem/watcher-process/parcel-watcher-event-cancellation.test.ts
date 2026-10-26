import { setImmediate } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
import {
  createWatcherProcessEventDeliveryQueue,
  prepareWatcherProcessEvents
} from './parcel-watcher-event-delivery'

const delivery = { includeDirectoryMetadata: true, maxEventsPerBatch: 100 }
const directory = { isDirectory: () => true }
const events = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    type: 'update' as const,
    path: `/${prefix}/${index}`
  }))
beforeEach(() => {
  statMock.mockReset()
})

describe('closed watcher metadata work', () => {
  it('removes queued lookups before a new live subscription needs their slots', async () => {
    const gate = Promise.withResolvers<void>()
    statMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/held/')) {
        await gate.promise
      }
      return directory
    })
    const held = prepareWatcherProcessEvents(events('held', 8), delivery)
    await setImmediate()
    expect(statMock.mock.calls.length).toBe(8)
    const deliver = vi.fn(async () => undefined)
    const onError = vi.fn()
    const queue = createWatcherProcessEventDeliveryQueue(delivery, deliver, onError)
    let live: ReturnType<typeof prepareWatcherProcessEvents> | undefined
    try {
      queue.enqueue(events('closed', 32))
      queue.close()
      live = prepareWatcherProcessEvents(events('live', 1), delivery)
      gate.resolve()
      expect(await live).toEqual([{ type: 'update', path: '/live/0', isDirectory: true }])
      await held
      await setImmediate()
      expect(statMock.mock.calls.map(([path]) => path)).toEqual([
        ...events('held', 8).map((event) => event.path),
        '/live/0'
      ])
      expect(deliver).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      queue.close()
      await held
      await live
    }
  })

  it('lets active stats settle without starting the rest of a closed batch', async () => {
    const gate = Promise.withResolvers<void>()
    statMock.mockImplementation(async () => {
      await gate.promise
      return directory
    })
    const deliver = vi.fn(async () => undefined)
    const onError = vi.fn()
    const queue = createWatcherProcessEventDeliveryQueue(delivery, deliver, onError)
    try {
      queue.enqueue(events('active', 32))
      await setImmediate()
      expect(statMock.mock.calls.length).toBe(8)
      queue.close()
      gate.resolve()
      await setImmediate()
      expect(statMock.mock.calls.length).toBe(8)
      expect(deliver).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      await prepareWatcherProcessEvents(events('next', 8), delivery)
      expect(statMock.mock.calls.length).toBe(16)
    } finally {
      gate.resolve()
      queue.close()
      await setImmediate()
    }
  })

  it('still delivers file-like invalidations for live stat failures and skips deleted paths', async () => {
    statMock.mockRejectedValue(new Error('file vanished'))
    expect(
      await prepareWatcherProcessEvents(
        [
          { type: 'update', path: '/vanished' },
          { type: 'delete', path: '/deleted' }
        ],
        delivery
      )
    ).toEqual([
      { type: 'update', path: '/vanished', isDirectory: false },
      { type: 'delete', path: '/deleted' }
    ])
    expect(statMock).toHaveBeenCalledTimes(1)
  })
})
