import * as path from 'path'
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
    releasePoll: ((entries: ReturnType<typeof dirent>[]) => void) | null,
    entries: ReturnType<typeof dirent>[]
  ): void {
    if (!releasePoll) {
      throw new Error('expected an in-flight poll')
    }
    releasePoll(entries)
  }

  function dirent(name: string, type: 'dir' | 'file' | 'symlink' = 'file') {
    return {
      name,
      isDirectory: () => type === 'dir',
      isSymbolicLink: () => type === 'symlink'
    }
  }

  it('does not overlap polling when a WSL snapshot scan is still in flight', async () => {
    const scheduleBatchFlush = vi.fn()
    let rootReads = 0
    let releasePoll: ((entries: ReturnType<typeof dirent>[]) => void) | null = null

    readdirMock.mockImplementation((dirPath: string) => {
      if (dirPath !== rootPath) {
        return Promise.resolve([])
      }
      rootReads += 1
      if (rootReads === 1) {
        return Promise.resolve([dirent('src', 'dir')])
      }
      if (rootReads === 2) {
        return new Promise<ReturnType<typeof dirent>[]>((resolve) => {
          releasePoll = resolve
        })
      }
      return Promise.resolve([dirent('src', 'dir')])
    })

    const root = await createWslWatcher(rootKey, rootPath, deps(scheduleBatchFlush))

    expect(rootReads).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(rootReads).toBe(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(rootReads).toBe(2)

    releasePollWith(releasePoll, [dirent('src', 'dir'), dirent('new-file.ts')])
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    await root.subscription.unsubscribe()
  })

  it('does not flush a poll that completes after unsubscribe', async () => {
    const scheduleBatchFlush = vi.fn()
    let rootReads = 0
    let releasePoll: ((entries: ReturnType<typeof dirent>[]) => void) | null = null

    readdirMock.mockImplementation((dirPath: string) => {
      if (dirPath !== rootPath) {
        return Promise.resolve([])
      }
      rootReads += 1
      if (rootReads === 1) {
        return Promise.resolve([dirent('src', 'dir')])
      }
      return new Promise<ReturnType<typeof dirent>[]>((resolve) => {
        releasePoll = resolve
      })
    })

    const root = await createWslWatcher(rootKey, rootPath, deps(scheduleBatchFlush))
    await vi.advanceTimersByTimeAsync(2_000)
    await root.subscription.unsubscribe()

    releasePollWith(releasePoll, [dirent('src', 'dir'), dirent('late-file.ts')])
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })

  it('does not probe root-level files during WSL snapshots', async () => {
    const scheduleBatchFlush = vi.fn()

    readdirMock.mockImplementation((dirPath: string) => {
      if (dirPath === rootPath) {
        return Promise.resolve([
          dirent('src', 'dir'),
          dirent('README.md'),
          dirent('package.json'),
          dirent('linked-dir', 'symlink')
        ])
      }
      return Promise.resolve([])
    })

    const root = await createWslWatcher(rootKey, rootPath, deps(scheduleBatchFlush))

    const readPaths = readdirMock.mock.calls.map(([dirPath]) => dirPath)
    expect(readPaths).toEqual([
      rootPath,
      path.join(rootPath, 'src'),
      path.join(rootPath, 'linked-dir')
    ])
    expect(readPaths).not.toContain(path.join(rootPath, 'README.md'))
    expect(readPaths).not.toContain(path.join(rootPath, 'package.json'))
    await root.subscription.unsubscribe()
  })
})
