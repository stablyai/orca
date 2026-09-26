import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const measurements = vi.hoisted(() => ({ scans: 0, entries: 0 }))
const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      const result = fs.readdirSync(...args)
      if (String(args[0]).endsWith('.pending-delete')) {
        measurements.scans++
        measurements.entries += result.length
      }
      return result
    }
  }
})

vi.mock('./host-tree-removal', () => ({ removeHostTree: removeHostTreeMock }))

import {
  cancelPendingHistoryTreeRemovalRetries,
  flushPendingWorktreeHistoryDeletions,
  HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS,
  MAX_PENDING_HISTORY_TREE_REMOVALS,
  schedulePendingHistoryTreeRemovals
} from './terminal-history-deletion'

describe('terminal history tombstone scan cost', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-scan-cost-'))
    installFakeAppEnvironment({ getPath: () => userDataDir })
    measurements.scans = 0
    measurements.entries = 0
    removeHostTreeMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cancelPendingHistoryTreeRemovalRetries()
    vi.useRealTimers()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedTombstones(root: string, count: number): void {
    for (let index = 0; index < count; index++) {
      mkdirSync(join(root, '.pending-delete', `old-session-${index}`), { recursive: true })
    }
  }

  function holdRemovals(): (() => void)[] {
    const releases: (() => void)[] = []
    removeHostTreeMock.mockImplementation(
      (dir) =>
        new Promise<void>((resolve) =>
          releases.push(() => {
            rmSync(dir, { recursive: true, force: true })
            resolve()
          })
        )
    )
    return releases
  }

  async function settleRemovalPromises(): Promise<void> {
    for (let index = 0; index < 8; index++) {
      await Promise.resolve()
    }
  }

  it('drains 1024 tombstones without enumerating the backlog after every completion', async () => {
    const root = join(userDataDir, 'terminal-history')
    const pendingRoot = join(root, '.pending-delete')
    seedTombstones(root, 1024)
    const releases = holdRemovals()

    schedulePendingHistoryTreeRemovals(root)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(MAX_PENDING_HISTORY_TREE_REMOVALS)
    while (releases.length > 0) {
      expect(releases.length).toBeLessThanOrEqual(MAX_PENDING_HISTORY_TREE_REMOVALS)
      releases.splice(0).forEach((release) => release())
      await vi.advanceTimersByTimeAsync(0)
    }

    const observed = { ...measurements }
    console.info(JSON.stringify({ tombstones: 1024, ...observed }))
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1024)
    expect(readdirSync(pendingRoot)).toEqual([])
    expect(observed.scans).toBeLessThanOrEqual(32)
  })

  it('discovers a new tombstone while a completion rescan is queued', async () => {
    const root = join(userDataDir, 'terminal-history')
    seedTombstones(root, 1)
    const releases = holdRemovals()
    schedulePendingHistoryTreeRemovals(root)
    releases.splice(0).forEach((release) => release())
    await settleRemovalPromises()
    expect(measurements.scans).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    mkdirSync(join(root, '.pending-delete', 'late-session'))
    await vi.advanceTimersByTimeAsync(0)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(2)
    releases.splice(0).forEach((release) => release())
    await flushPendingWorktreeHistoryDeletions()
    expect(readdirSync(join(root, '.pending-delete'))).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains queued rescans without requiring the test clock to advance', async () => {
    const root = join(userDataDir, 'terminal-history')
    seedTombstones(root, 130)
    removeHostTreeMock.mockImplementation(async (dir) => {
      rmSync(dir, { recursive: true, force: true })
    })
    await flushPendingWorktreeHistoryDeletions()
    expect(removeHostTreeMock).toHaveBeenCalledTimes(130)
    expect(readdirSync(join(root, '.pending-delete'))).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a second root eligible when another root consumes its rescan slots', async () => {
    const nativeRoot = join(userDataDir, 'terminal-history')
    const wslRoot = join(userDataDir, 'terminal-history-wsl', 'Ubuntu')
    seedTombstones(nativeRoot, 32)
    seedTombstones(wslRoot, 32)
    const releases = holdRemovals()
    schedulePendingHistoryTreeRemovals(nativeRoot)
    schedulePendingHistoryTreeRemovals(wslRoot)
    seedTombstones(nativeRoot, 160)
    seedTombstones(wslRoot, 160)

    while (releases.length > 0) {
      expect(releases.length).toBeLessThanOrEqual(MAX_PENDING_HISTORY_TREE_REMOVALS)
      releases.splice(0).forEach((release) => release())
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(removeHostTreeMock).toHaveBeenCalledTimes(320)
    expect(readdirSync(join(nativeRoot, '.pending-delete'))).toEqual([])
    expect(readdirSync(join(wslRoot, '.pending-delete'))).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves delayed failure retries while successful removals replenish the queue', async () => {
    const root = join(userDataDir, 'terminal-history')
    seedTombstones(root, 130)
    const failedDir = join(root, '.pending-delete', 'old-session-0')
    removeHostTreeMock.mockImplementation(async (dir) => {
      if (dir === failedDir) {
        throw new Error('EBUSY')
      }
      rmSync(dir, { recursive: true, force: true })
    })
    await flushPendingWorktreeHistoryDeletions()
    expect(removeHostTreeMock).toHaveBeenCalledTimes(130)
    expect(readdirSync(join(root, '.pending-delete'))).toEqual(['old-session-0'])
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[0] - 1)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(130)
    await vi.advanceTimersByTimeAsync(1)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(131)
    await vi.advanceTimersByTimeAsync(HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[1])
    expect(removeHostTreeMock).toHaveBeenCalledTimes(132)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a queued completion rescan during fixture cleanup', async () => {
    const root = join(userDataDir, 'terminal-history')
    seedTombstones(root, 65)
    const releases = holdRemovals()
    schedulePendingHistoryTreeRemovals(root)
    releases.splice(0).forEach((release) => release())
    await settleRemovalPromises()
    expect(vi.getTimerCount()).toBe(1)
    cancelPendingHistoryTreeRemovalRetries()
    await vi.advanceTimersByTimeAsync(0)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(64)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restart exhausted retries when a different root frees more slots', async () => {
    const nativeRoot = join(userDataDir, 'terminal-history')
    const wslRoot = join(userDataDir, 'terminal-history-wsl', 'Ubuntu')
    seedTombstones(nativeRoot, 32)
    seedTombstones(wslRoot, 130)
    const releases: (() => void)[] = []
    let wslRemovals = 0
    removeHostTreeMock.mockImplementation((dir) => {
      if (dir.startsWith(wslRoot)) {
        wslRemovals++
        if (wslRemovals > 1) {
          return Promise.reject(new Error('EBUSY'))
        }
        rmSync(dir, { recursive: true, force: true })
        return Promise.resolve()
      }
      return new Promise<void>((resolve) =>
        releases.push(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      )
    })
    schedulePendingHistoryTreeRemovals(nativeRoot)
    schedulePendingHistoryTreeRemovals(wslRoot)
    await vi.advanceTimersByTimeAsync(0)
    expect(wslRemovals).toBe(33)

    // Native removals stay in flight while WSL's failures reach their last retry.
    for (const delay of HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(wslRemovals).toBe(97)
    releases.splice(0).forEach((release) => release())
    await vi.advanceTimersByTimeAsync(0)
    expect(wslRemovals).toBe(97)
    expect(vi.getTimerCount()).toBe(0)
  })
})
