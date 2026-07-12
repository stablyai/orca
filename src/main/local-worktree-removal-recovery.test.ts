import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, listWorktreesStrictMock, removeLocalWorktreePathMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    listWorktreesStrictMock: vi.fn(),
    removeLocalWorktreePathMock: vi.fn()
  })
)

vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-worktree-filesystem', () => ({
  removeLocalWorktreePath: removeLocalWorktreePathMock
}))

vi.mock('./git/worktree', () => ({
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  recoverLocalWindowsWorktreeRemoval,
  removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval
} from './local-worktree-removal-recovery'

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('recoverLocalWindowsWorktreeRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    listWorktreesStrictMock.mockReset()
    removeLocalWorktreePathMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    listWorktreesStrictMock.mockResolvedValue([])
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

      const result = await recoverLocalWindowsWorktreeRemoval({
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

  it('finishes a clean non-force deletion after Git leaves a Windows directory behind', async () => {
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('git worktree remove failed'), {
        stderr:
          "error: failed to delete 'C:/repo/worktree/delete-e2e-held-cwd': Directory not empty"
      })

      const result = await recoverLocalWindowsWorktreeRemoval({
        error,
        force: false,
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

  it('recovers localized Windows failures after Git already removed the registration', async () => {
    await withPlatform('win32', async () => {
      const result = await recoverLocalWindowsWorktreeRemoval({
        error: Object.assign(new Error('git worktree remove failed'), {
          stderr: "Fehler: 'C:/repo/worktree/feature' konnte nicht gelöscht werden"
        }),
        force: false,
        canonicalWorktreePath: 'C:/repo/worktree/feature',
        repoPath: 'C:/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
        deleteBranch: false,
        closeWatcher: vi.fn().mockResolvedValue(undefined)
      })

      expect(removeLocalWorktreePathMock).toHaveBeenCalledWith('C:/repo/worktree/feature', {})
      expect(result).toEqual({})
    })
  })

  it('does not recover unrelated localized failures while Git still owns the row', async () => {
    await withPlatform('win32', async () => {
      listWorktreesStrictMock.mockResolvedValue([
        {
          path: 'C:/repo/worktree/feature',
          head: 'abc123',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await expect(
        recoverLocalWindowsWorktreeRemoval({
          error: Object.assign(new Error('git worktree remove failed'), {
            stderr: 'Fehler: unerwarteter Git-Zustand'
          }),
          force: false,
          canonicalWorktreePath: 'C:/repo/worktree/feature',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
          deleteBranch: false,
          closeWatcher: vi.fn().mockResolvedValue(undefined)
        })
      ).resolves.toBeUndefined()
      expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
    })
  })

  it('does not recover partial filesystem deletion wording off Windows', async () => {
    await withPlatform('linux', async () => {
      const error = Object.assign(new Error('git worktree remove failed'), {
        stderr: "error: failed to delete 'C:/repo/worktree/delete-e2e-held-cwd': Permission denied"
      })

      await expect(
        recoverLocalWindowsWorktreeRemoval({
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

  it('does not recover a locked registration after a filesystem removal failure', async () => {
    await withPlatform('win32', async () => {
      const registeredWorktree = {
        branch: 'refs/heads/feature',
        head: 'abc123',
        locked: true,
        lockReason: 'active agent'
      }
      const closeWatcher = vi.fn().mockResolvedValue(undefined)

      await expect(
        recoverLocalWindowsWorktreeRemoval({
          error: Object.assign(new Error('git worktree remove failed'), {
            stderr: 'error: failed to delete deep/file.txt: Filename too long'
          }),
          force: true,
          canonicalWorktreePath: 'C:/workspaces/feature',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree,
          deleteBranch: true,
          closeWatcher
        })
      ).rejects.toThrow('Worktree is locked by Git. Lock reason: active agent')

      expect(closeWatcher).not.toHaveBeenCalled()
      expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
      expect(listWorktreesStrictMock).not.toHaveBeenCalled()
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })

  it.each([
    "error: failed to delete 'C:/repo/worktree/feature': Directory not empty",
    'error: failed to delete deep/file.txt: Filename too long'
  ])(
    'does not recover a recognized Windows failure while Git still owns the row: %s',
    async (stderr) => {
      await withPlatform('win32', async () => {
        listWorktreesStrictMock.mockResolvedValue([
          {
            path: 'C:/repo/worktree/feature',
            head: 'abc123',
            branch: 'refs/heads/feature',
            isBare: false,
            isMainWorktree: false
          }
        ])
        const closeWatcher = vi.fn().mockResolvedValue(undefined)

        await expect(
          recoverLocalWindowsWorktreeRemoval({
            error: Object.assign(new Error('git worktree remove failed'), { stderr }),
            force: true,
            canonicalWorktreePath: 'C:/repo/worktree/feature',
            repoPath: 'C:/repo',
            localWorktreeGitOptions: { wslDistro: 'Ubuntu' },
            registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
            deleteBranch: true,
            closeWatcher
          })
        ).resolves.toBeUndefined()

        expect(listWorktreesStrictMock).toHaveBeenCalledWith('C:/repo', { wslDistro: 'Ubuntu' })
        expect(closeWatcher).not.toHaveBeenCalled()
        expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
      })
    }
  )

  it('does not recover when structural registration verification fails', async () => {
    await withPlatform('win32', async () => {
      listWorktreesStrictMock.mockRejectedValue(new Error('git list failed'))
      const closeWatcher = vi.fn().mockResolvedValue(undefined)

      await expect(
        recoverLocalWindowsWorktreeRemoval({
          error: Object.assign(new Error('git worktree remove failed'), {
            stderr: "error: failed to delete 'C:/repo/worktree/feature': Directory not empty"
          }),
          force: true,
          canonicalWorktreePath: 'C:/repo/worktree/feature',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
          deleteBranch: true,
          closeWatcher
        })
      ).resolves.toBeUndefined()

      expect(closeWatcher).not.toHaveBeenCalled()
      expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
    })
  })
})

describe('removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    listWorktreesStrictMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    listWorktreesStrictMock.mockResolvedValue([])
  })

  it('does not override a locked missing registration', async () => {
    await expect(
      removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
        canonicalWorktreePath: 'C:/workspaces/feature',
        repoPath: 'C:/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: {
          branch: 'refs/heads/feature',
          head: 'abc123',
          locked: true,
          lockReason: 'active agent'
        },
        deleteBranch: true
      })
    ).rejects.toThrow('Worktree is locked by Git')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not report success when prune leaves the registration behind', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      {
        path: 'C:/workspaces/feature',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await expect(
      removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
        canonicalWorktreePath: 'C:/workspaces/feature',
        repoPath: 'C:/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
        deleteBranch: true
      })
    ).rejects.toThrow('Git still has stale worktree registration')
  })
})
