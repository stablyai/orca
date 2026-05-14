import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readdirMock } = vi.hoisted(() => ({
  readdirMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  readdir: readdirMock
}))

import { createWslWatcher } from './filesystem-watcher-wsl'
import type { WatchedRoot } from './filesystem-watcher-wsl'

describe('createWslWatcher', () => {
  const rootPath = '/mnt/wsl/repo'
  const rootKey = rootPath

  beforeEach(() => {
    vi.useFakeTimers()
    readdirMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function deps(scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void) {
    return {
      ignoreDirs: ['node_modules', '.git'],
      scheduleBatchFlush,
      watchedRoots: new Map<string, WatchedRoot>()
    }
  }

  function releasePollWith(
    releasePoll: ((entries: string[]) => void) | null,
    entries: string[]
  ): void {
    if (!releasePoll) {
      throw new Error('expected an in-flight poll')
    }
    releasePoll(entries)
  }

  it('does not overlap polling when a WSL snapshot scan is still in flight', async () => {
    const scheduleBatchFlush = vi.fn()
    let rootReads = 0
    let releasePoll: ((entries: string[]) => void) | null = null

    readdirMock.mockImplementation((dirPath: string) => {
      if (dirPath !== rootPath) {
        return Promise.resolve([])
      }
      rootReads += 1
      if (rootReads === 1) {
        return Promise.resolve(['src'])
      }
      if (rootReads === 2) {
        return new Promise<string[]>((resolve) => {
          releasePoll = resolve
        })
      }
      return Promise.resolve(['src'])
    })

    const root = await createWslWatcher(rootKey, rootPath, deps(scheduleBatchFlush))

    expect(rootReads).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(rootReads).toBe(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(rootReads).toBe(2)

    releasePollWith(releasePoll, ['src', 'new-file.ts'])
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    await root.subscription.unsubscribe()
  })

  it('does not flush a poll that completes after unsubscribe', async () => {
    const scheduleBatchFlush = vi.fn()
    let rootReads = 0
    let releasePoll: ((entries: string[]) => void) | null = null

    readdirMock.mockImplementation((dirPath: string) => {
      if (dirPath !== rootPath) {
        return Promise.resolve([])
      }
      rootReads += 1
      if (rootReads === 1) {
        return Promise.resolve(['src'])
      }
      return new Promise<string[]>((resolve) => {
        releasePoll = resolve
      })
    })

    const root = await createWslWatcher(rootKey, rootPath, deps(scheduleBatchFlush))
    await vi.advanceTimersByTimeAsync(2_000)
    await root.subscription.unsubscribe()

    releasePollWith(releasePoll, ['src', 'late-file.ts'])
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })
})
