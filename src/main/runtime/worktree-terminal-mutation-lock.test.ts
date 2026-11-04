import { describe, expect, it, vi } from 'vitest'
import {
  WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR,
  WorktreeTerminalMutationLock
} from './worktree-terminal-mutation-lock'

const KEY = 'repo::/tmp/worktree'

describe('WorktreeTerminalMutationLock', () => {
  it('hands the turn onward when a queued sleep abandons ahead of a spawn', async () => {
    vi.useFakeTimers()
    try {
      const lock = new WorktreeTerminalMutationLock()
      const releaseSpawn = await lock.acquire(KEY, 'shared')
      const sleep = lock.acquire(KEY, 'exclusive', Date.now() + 1_000)
      const rejection = expect(sleep).rejects.toThrow(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
      let laterSpawnAcquired = false
      const laterSpawn = lock.acquire(KEY, 'shared').then((release) => {
        laterSpawnAcquired = true
        return release
      })

      await vi.advanceTimersByTimeAsync(1_001)
      await rejection
      // The spawn was queued behind the sleep; its abandonment must release it.
      const releaseLater = await laterSpawn
      expect(laterSpawnAcquired).toBe(true)
      releaseSpawn()
      releaseLater()
      expect(lock.trackedKeyCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
