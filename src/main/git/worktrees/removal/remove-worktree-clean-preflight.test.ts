import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  gitStreamStdoutMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  gitStreamStdoutMock: vi.fn()
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-stream-stdout', () => ({
  gitStreamStdout: gitStreamStdoutMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../../source-control/resolve-git-dir', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('../../source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import { resetWorktreeRemovalState } from './remove-worktree-test-harness'

import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS } from '../worktree-operation-options'

beforeEach(() => {
  resetWorktreeRemovalState()
})

describe('assertWorktreeCleanForRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    // A failed submodule probe leaves the verdict to Git.
    gitStreamStdoutMock.mockReset().mockRejectedValue(new Error('git exited with 128: '))
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
