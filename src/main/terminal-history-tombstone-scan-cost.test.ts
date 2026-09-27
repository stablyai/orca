import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const reads = vi.hoisted(() => ({ count: 0, names: 0, failNext: 0 }))
const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof NodeFsPromises>()
  return {
    ...fsp,
    readdir: async (...args: Parameters<typeof fsp.readdir>) => {
      if (!String(args[0]).endsWith('.pending-delete')) {
        return fsp.readdir(...args)
      }
      reads.count++
      if (reads.failNext > 0) {
        reads.failNext--
        throw new Error('EACCES: permission denied, scandir')
      }
      const result = await fsp.readdir(...args)
      reads.names += Array.isArray(result) ? result.length : 0
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
    reads.count = 0
    reads.names = 0
    reads.failNext = 0
    removeHostTreeMock.mockReset()
  })

  afterEach(() => {
    cancelPendingHistoryTreeRemovalRetries()
    vi.useRealTimers()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedTombstones(root: string, count: number): void {
    for (let index = 0; index < count; index++) {
      mkdirSync(join(root, '.pending-delete', `old-session-${index}`), {
        recursive: true
      })
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

  /** Drain only the microtask queue, so no queued directory read can land yet. */
  async function settleRemovalPromises(): Promise<void> {
    for (let index = 0; index < 8; index++) {
      await Promise.resolve()
    }
  }

  /** Let real filesystem reads land. Callers using fake timers must drive the clock instead. */
  async function waitFor(label: string, condition: () => boolean): Promise<void> {
    for (let index = 0; index < 500; index++) {
      if (condition()) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  it('drains 1024 tombstones without re-reading the directory per completion', async () => {
    const root = join(userDataDir, 'terminal-history')
    const pendingRoot = join(root, '.pending-delete')
    seedTombstones(root, 1024)
    const releases = holdRemovals()

    await schedulePendingHistoryTreeRemovals(root)
    expect(reads.count).toBe(1)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(MAX_PENDING_HISTORY_TREE_REMOVALS)
    while (releases.length > 0) {
      expect(releases.length).toBeLessThanOrEqual(MAX_PENDING_HISTORY_TREE_REMOVALS)
      releases.splice(0).forEach((release) => release())
      await settleRemovalPromises()
    }

    expect(removeHostTreeMock).toHaveBeenCalledTimes(1024)
    expect(readdirSync(pendingRoot)).toEqual([])
    // One read fills the queue; the handful after it only confirm the directory drained, so the
    // count must stay flat in the backlog size rather than tracking completion batches.
    expect(reads.count).toBeLessThanOrEqual(8)
    expect(reads.names).toBeLessThanOrEqual(1024 + MAX_PENDING_HISTORY_TREE_REMOVALS)
  })

  it('picks up a tombstone created after the queued names were read', async () => {
    const root = join(userDataDir, 'terminal-history')
    const pendingRoot = join(root, '.pending-delete')
    seedTombstones(root, 1)
    const releases = holdRemovals()

    await schedulePendingHistoryTreeRemovals(root)
    mkdirSync(join(pendingRoot, 'late-session'))
    releases.splice(0).forEach((release) => release())

    // The completion exhausted the queue, so its refill read discovers the late arrival.
    await waitFor('late tombstone admission', () => removeHostTreeMock.mock.calls.length === 2)
    releases.splice(0).forEach((release) => release())
    await flushPendingWorktreeHistoryDeletions()
    expect(readdirSync(pendingRoot)).toEqual([])
  })

  it('drains both roots within the shared admission cap without per-completion reads', async () => {
    const nativeRoot = join(userDataDir, 'terminal-history')
    const wslRoot = join(userDataDir, 'terminal-history-wsl', 'Ubuntu')
    seedTombstones(nativeRoot, 160)
    seedTombstones(wslRoot, 160)
    let inFlight = 0
    let peakInFlight = 0
    removeHostTreeMock.mockImplementation(async (dir) => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      rmSync(dir, { recursive: true, force: true })
      inFlight--
    })

    await flushPendingWorktreeHistoryDeletions()

    expect(removeHostTreeMock).toHaveBeenCalledTimes(320)
    expect(peakInFlight).toBeLessThanOrEqual(MAX_PENDING_HISTORY_TREE_REMOVALS)
    expect(readdirSync(join(nativeRoot, '.pending-delete'))).toEqual([])
    expect(readdirSync(join(wslRoot, '.pending-delete'))).toEqual([])
    // Two roots, so a couple of reads each rather than one per completion.
    expect(reads.count).toBeLessThanOrEqual(12)
  })

  it('keeps draining after a directory read fails mid-drain', async () => {
    const root = join(userDataDir, 'terminal-history')
    const pendingRoot = join(root, '.pending-delete')
    seedTombstones(root, MAX_PENDING_HISTORY_TREE_REMOVALS + 1)
    const releases = holdRemovals()

    await schedulePendingHistoryTreeRemovals(root)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(MAX_PENDING_HISTORY_TREE_REMOVALS)

    // The refill these completions request is the one that fails.
    reads.failNext = 1
    releases.splice(0).forEach((release) => release())
    await settleRemovalPromises()
    // The queued 65th still came from memory, so the failed read cost no progress.
    expect(removeHostTreeMock).toHaveBeenCalledTimes(MAX_PENDING_HISTORY_TREE_REMOVALS + 1)

    mkdirSync(join(pendingRoot, 'late-after-failed-read'))
    releases.splice(0).forEach((release) => release())
    // A later completion must be able to read again rather than stay wedged on the failure.
    await waitFor(
      'recovery after failed read',
      () => removeHostTreeMock.mock.calls.length === MAX_PENDING_HISTORY_TREE_REMOVALS + 2
    )
    releases.splice(0).forEach((release) => release())
    await flushPendingWorktreeHistoryDeletions()
    expect(readdirSync(pendingRoot)).toEqual([])
  })

  it('drops an in-flight refill during fixture cleanup', async () => {
    const root = join(userDataDir, 'terminal-history')
    seedTombstones(root, MAX_PENDING_HISTORY_TREE_REMOVALS + 1)
    const releases = holdRemovals()

    await schedulePendingHistoryTreeRemovals(root)
    mkdirSync(join(root, '.pending-delete', 'late-session'))
    releases.splice(0).forEach((release) => release())
    await settleRemovalPromises()
    const admittedBeforeCleanup = removeHostTreeMock.mock.calls.length

    cancelPendingHistoryTreeRemovalRetries()
    await waitFor('the dropped refill to land', () => reads.count >= 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(removeHostTreeMock).toHaveBeenCalledTimes(admittedBeforeCleanup)
  })

  it('preserves delayed failure retries while successful removals replenish the queue', async () => {
    // Fake timers must be armed before the failure so its retry lands on the test clock.
    vi.useFakeTimers()
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

    await vi.advanceTimersByTimeAsync(HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[0] - 1)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(130)
    await vi.advanceTimersByTimeAsync(1)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(131)
    await vi.advanceTimersByTimeAsync(HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[1])
    expect(removeHostTreeMock).toHaveBeenCalledTimes(132)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a tombstone past its attempt budget when another root frees slots', async () => {
    vi.useFakeTimers()
    const nativeRoot = join(userDataDir, 'terminal-history')
    const wslRoot = join(userDataDir, 'terminal-history-wsl', 'Ubuntu')
    seedTombstones(nativeRoot, 32)
    seedTombstones(wslRoot, 130)
    const releases: (() => void)[] = []
    const attemptsByDir = new Map<string, number>()
    removeHostTreeMock.mockImplementation((dir) => {
      attemptsByDir.set(dir, (attemptsByDir.get(dir) ?? 0) + 1)
      if (dir.startsWith(wslRoot)) {
        return Promise.reject(new Error('EBUSY'))
      }
      return new Promise<void>((resolve) =>
        releases.push(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      )
    })
    await schedulePendingHistoryTreeRemovals(nativeRoot)
    await schedulePendingHistoryTreeRemovals(wslRoot)

    // Every WSL tombstone that was admitted exhausts its retries while native removals stay in flight.
    for (const delay of HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(vi.getTimerCount()).toBe(0)
    const maxAttempts = 1 + HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS.length
    const exhausted = [...attemptsByDir.entries()].filter(([, count]) => count === maxAttempts)
    expect(exhausted.length).toBeGreaterThan(0)

    releases.splice(0).forEach((release) => release())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    // Freeing another root's slots may give untried tombstones a first attempt, but must never hand
    // an exhausted one a fresh attempt.
    for (const count of attemptsByDir.values()) {
      expect(count).toBeLessThanOrEqual(maxAttempts)
    }
    for (const [dir] of exhausted) {
      expect(attemptsByDir.get(dir)).toBe(maxAttempts)
    }
  })
})
