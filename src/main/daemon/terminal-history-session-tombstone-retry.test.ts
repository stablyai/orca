import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('../host-tree-removal', () => ({
  removeHostTree: removeHostTreeMock
}))

import { getHistorySessionDirName } from './history-paths'
import {
  cancelPendingSessionTreeRemovalRetries,
  removeTerminalHistorySessionTrees,
  SESSION_TREE_REMOVAL_RETRY_DELAYS_MS
} from './terminal-history-session-tombstone'

/** Mirrors the worktree-level tombstone retry: a session tree whose rm fails must be re-queued
 *  in-process instead of waiting for the next HistoryManager construction. */
describe('tombstoned session tree removal retries', () => {
  let basePath: string

  beforeEach(() => {
    basePath = mkdtempSync(join(tmpdir(), 'orca-session-tombstone-retry-'))
    removeHostTreeMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cancelPendingSessionTreeRemovalRetries()
    vi.useRealTimers()
    rmSync(basePath, { recursive: true, force: true })
  })

  function seedSession(sessionId: string): void {
    const dir = join(basePath, getHistorySessionDirName(sessionId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'segment-0.log'), 'x')
  }

  it('re-queues a tombstone whose removal failed, then stops after the last attempt', async () => {
    seedSession('session-busy')
    removeHostTreeMock.mockRejectedValue(
      Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    )

    await removeTerminalHistorySessionTrees(basePath, 'session-busy')
    await vi.advanceTimersByTimeAsync(0)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)

    for (const [index, retryDelayMs] of SESSION_TREE_REMOVAL_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(retryDelayMs)
      expect(removeHostTreeMock).toHaveBeenCalledTimes(index + 2)
    }

    // Bounded: a permanently wedged tree waits for the next construction's drain.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(
      SESSION_TREE_REMOVAL_RETRY_DELAYS_MS.length + 1
    )
    expect(removeHostTreeMock).toHaveBeenLastCalledWith(expect.stringContaining('.pending-delete'))
  })

  it('does not re-arm a retry after the removal succeeds', async () => {
    seedSession('session-clean')
    removeHostTreeMock.mockResolvedValue(undefined)

    await removeTerminalHistorySessionTrees(basePath, 'session-clean')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(SESSION_TREE_REMOVAL_RETRY_DELAYS_MS[0])

    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
  })
})
