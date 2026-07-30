import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string

const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  }
}))

vi.mock('./host-tree-removal', () => ({
  removeHostTree: removeHostTreeMock
}))

import { hashWorktreeId } from './terminal-history-paths'
import {
  cancelPendingHistoryTreeRemovalRetries,
  deleteWorktreeHistoryDir,
  HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS
} from './terminal-history-deletion'

/** A tombstone whose rm fails once used to sit on disk for the rest of the session — only the next
 *  process start re-queued it. Prove the failure re-arms in-process, and that it stays bounded. */
describe('tombstoned history removal retries', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-retry-'))
    removeHostTreeMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cancelPendingHistoryTreeRemovalRetries()
    vi.useRealTimers()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedWorktreeHistory(worktreeId: string): void {
    const dir = join(userDataDir, 'terminal-history', hashWorktreeId(worktreeId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), '{}')
  }

  it('re-queues a tombstone whose removal failed, then stops after the last attempt', async () => {
    seedWorktreeHistory('repo-1::/path/busy-wt')
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    removeHostTreeMock.mockRejectedValue(busy)

    deleteWorktreeHistoryDir('repo-1::/path/busy-wt')
    await vi.advanceTimersByTimeAsync(0)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)

    for (const [index, retryDelayMs] of HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(retryDelayMs)
      expect(removeHostTreeMock).toHaveBeenCalledTimes(index + 2)
    }

    // Bounded: a permanently wedged tree stops burning timers and waits for the next startup drain.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(
      HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS.length + 1
    )
    expect(removeHostTreeMock).toHaveBeenLastCalledWith(expect.stringContaining('.pending-delete'))
  })

  it('does not re-arm a retry after the removal succeeds', async () => {
    seedWorktreeHistory('repo-1::/path/clean-wt')
    removeHostTreeMock.mockResolvedValue(undefined)

    deleteWorktreeHistoryDir('repo-1::/path/clean-wt')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[0])

    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
  })
})
