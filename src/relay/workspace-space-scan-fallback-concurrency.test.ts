import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from './dispatcher'

const { lstatMock, opendirMock, spawnMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  opendir: opendirMock
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

function createContext(signal?: AbortSignal): RequestContext {
  return {
    clientId: 1,
    isStale: () => false,
    signal
  }
}

function createDirStat(size = 16) {
  return {
    size,
    isSymbolicLink: () => false,
    isDirectory: () => true
  }
}

function createFileStat(size: number) {
  return {
    size,
    isSymbolicLink: () => false,
    isDirectory: () => false
  }
}

describe('relay workspace space scan fallback concurrency', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    opendirMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scans portable fallback entries concurrently without retaining a child tree', async () => {
    const rootPath = '/repo'
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('du not found'), { code: 'ENOENT' })
    })
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { name: 'a.txt' }
        yield { name: 'b.txt' }
      }
    })

    let started = 0
    let active = 0
    let maxActive = 0
    let released = false
    const releases: (() => void)[] = []
    const releaseAll = (): void => {
      released = true
      while (releases.length > 0) {
        releases.shift()?.()
      }
    }
    lstatMock.mockImplementation((targetPath: string) => {
      if (targetPath === rootPath) {
        return Promise.resolve(createDirStat())
      }
      started += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      const finish = (): ReturnType<typeof createFileStat> => {
        active -= 1
        return createFileStat(targetPath.endsWith('a.txt') ? 128 : 256)
      }
      if (released) {
        return Promise.resolve(finish())
      }
      return new Promise((resolve) => {
        releases.push(() => resolve(finish()))
      })
    })

    const scanPromise = scanWorkspaceSpaceDirectory(rootPath, createContext())
    try {
      await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(2), { timeout: 200 })
    } finally {
      releaseAll()
    }

    await expect(scanPromise).resolves.toMatchObject({
      topLevelItems: expect.arrayContaining([
        expect.objectContaining({ name: 'a.txt', sizeBytes: 128 }),
        expect.objectContaining({ name: 'b.txt', sizeBytes: 256 })
      ])
    })
    expect(maxActive).toBeGreaterThan(1)
  })
})
