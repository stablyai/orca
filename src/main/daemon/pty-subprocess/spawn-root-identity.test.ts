import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSpawnedRootCreationTimeMs } from './spawn-root-identity'

let platformDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
})

describe('captureSpawnedRootCreationTimeMs', () => {
  it.each([[0], [-1], [1.5], [Number.NaN]])(
    'returns undefined for the invalid pid %p without reading the table',
    async (pid) => {
      const readFreshRows = vi.fn()
      await expect(
        captureSpawnedRootCreationTimeMs(pid, {
          isStartTimeAvailable: () => true,
          readFreshRows
        })
      ).resolves.toBeUndefined()
      expect(readFreshRows).not.toHaveBeenCalled()
    }
  )

  it('returns undefined where the table has no creation times', async () => {
    const readFreshRows = vi.fn()
    await expect(
      captureSpawnedRootCreationTimeMs(4242, {
        isStartTimeAvailable: () => false,
        readFreshRows
      })
    ).resolves.toBeUndefined()
    expect(readFreshRows).not.toHaveBeenCalled()
  })

  it('anchors the just-spawned root to its creation time', async () => {
    const readFreshRows = vi.fn().mockResolvedValue([
      { pid: 4241, creationTimeMs: 100 },
      { pid: 4242, creationTimeMs: 200 }
    ])
    await expect(
      captureSpawnedRootCreationTimeMs(4242, {
        isStartTimeAvailable: () => true,
        readFreshRows
      })
    ).resolves.toBe(200)
  })

  it('returns undefined when the fresh table no longer lists the root', async () => {
    const readFreshRows = vi.fn().mockResolvedValue([{ pid: 4241, creationTimeMs: 100 }])
    await expect(
      captureSpawnedRootCreationTimeMs(4242, {
        isStartTimeAvailable: () => true,
        readFreshRows
      })
    ).resolves.toBeUndefined()
  })

  it('returns undefined when the table read rejects', async () => {
    const readFreshRows = vi.fn().mockRejectedValue(new Error('unreadable'))
    await expect(
      captureSpawnedRootCreationTimeMs(4242, {
        isStartTimeAvailable: () => true,
        readFreshRows
      })
    ).resolves.toBeUndefined()
  })
})
