import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, removeLocalWorktreePathMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  removeLocalWorktreePathMock: vi.fn()
}))

vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-worktree-filesystem', () => ({
  removeLocalWorktreePath: removeLocalWorktreePathMock
}))

import { recoverLocalWindowsLongPathWorktreeRemoval } from './local-worktree-removal-recovery'

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('recoverLocalWindowsLongPathWorktreeRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    removeLocalWorktreePathMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    removeLocalWorktreePathMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recovers Git for Windows partial filesystem deletion failures', async () => {
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('git worktree remove failed'), {
        stderr: "error: failed to delete 'C:/repo/worktree/delete-e2e-held-cwd': Permission denied"
      })

      const result = await recoverLocalWindowsLongPathWorktreeRemoval({
        error,
        force: true,
        canonicalWorktreePath: 'C:/repo/worktree/delete-e2e-held-cwd',
        repoPath: 'C:/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'refs/heads/delete-e2e-held-cwd', head: 'abc123' },
        deleteBranch: true,
        closeWatcher: vi.fn().mockResolvedValue(undefined)
      })

      expect(removeLocalWorktreePathMock).toHaveBeenCalledWith(
        'C:/repo/worktree/delete-e2e-held-cwd',
        {}
      )
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: 'C:/repo'
      })
      expect(result).toEqual({
        preservedBranch: {
          branchName: 'delete-e2e-held-cwd',
          head: 'abc123'
        }
      })
    })
  })

  it('does not recover partial filesystem deletion wording off Windows', async () => {
    await withPlatform('linux', async () => {
      const error = Object.assign(new Error('git worktree remove failed'), {
        stderr: "error: failed to delete 'C:/repo/worktree/delete-e2e-held-cwd': Permission denied"
      })

      await expect(
        recoverLocalWindowsLongPathWorktreeRemoval({
          error,
          force: true,
          canonicalWorktreePath: 'C:/repo/worktree/delete-e2e-held-cwd',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/delete-e2e-held-cwd', head: 'abc123' },
          deleteBranch: true,
          closeWatcher: vi.fn().mockResolvedValue(undefined)
        })
      ).resolves.toBeUndefined()
      expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
    })
  })
})
