import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunnerModule from './runner'
import type * as StatusModule from './status'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }))

vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./status', async (importOriginal) => ({
  ...(await importOriginal<typeof StatusModule>()),
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>): Promise<T> => run()
}))

import { pruneWorktrees, WORKTREE_PRUNE_TIMEOUT_MS } from './worktree'

describe('pruneWorktrees', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockClear()
  })

  it('bounds native and WSL prune commands by default', async () => {
    await pruneWorktrees('/repo', { wslDistro: 'Ubuntu' })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/repo',
      timeout: WORKTREE_PRUNE_TIMEOUT_MS,
      wslDistro: 'Ubuntu'
    })
    expect(WORKTREE_PRUNE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
