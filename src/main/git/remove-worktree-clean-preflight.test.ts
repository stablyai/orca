import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import { resetWorktreeRemovalState } from './remove-worktree-test-harness'

import { assertWorktreeCleanForRemoval, WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS } from './worktree'

beforeEach(() => {
  resetWorktreeRemovalState()
})

describe('assertWorktreeCleanForRemoval', () => {
  beforeEach(() => {
    // Calls after the status read are the submodule probe's `ls-files`; failing leaves the verdict to Git.
    gitExecFileAsyncMock
      .mockReset()
      .mockRejectedValue(new Error('git ls-files exited with code 128'))
  })

  it('ignores configured linked paths without mutating them before preflight', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '?? node_modules\0', stderr: '' })

    await expect(
      assertWorktreeCleanForRemoval('/repo-feature', false, {
        ignoredUntrackedPaths: ['node_modules']
      })
    ).resolves.toBeUndefined()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      { cwd: '/repo-feature', timeout: WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS }
    )
  })

  it('still rejects real changes when configured linked paths are ignored', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '?? node_modules\0 M src/index.ts\0',
      stderr: ''
    })

    await expect(
      assertWorktreeCleanForRemoval('/repo-feature', false, {
        ignoredUntrackedPaths: ['node_modules']
      })
    ).rejects.toMatchObject({ message: 'Worktree has uncommitted or untracked changes.' })
  })
})
