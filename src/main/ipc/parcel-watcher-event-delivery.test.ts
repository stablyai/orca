import { setImmediate } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ stat: statMock }))

import { prepareWatcherProcessEvents } from './parcel-watcher-event-delivery'

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
