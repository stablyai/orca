import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalWorktreeFilesystem from './local-worktree-filesystem'

const { gitExecFileAsyncMock, listWorktreesStrictMock, removeLocalWorktreePathMock, hostRmMock } =
  vi.hoisted(() => ({
    gitExecFileAsyncMock: vi.fn(),
    listWorktreesStrictMock: vi.fn(),
    removeLocalWorktreePathMock: vi.fn(),
    hostRmMock: vi.fn()
  }))

vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-worktree-filesystem', () => ({
  removeLocalWorktreePath: removeLocalWorktreePathMock
}))

vi.mock('./asar-transparent-fs', () => ({ rm: hostRmMock }))

vi.mock('./git/worktree', () => ({
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  recoverPartialLocalWorktreeRemoval,
  removeStaleLocalWorktreeRegistration
} from './local-worktree-removal-recovery'
import { NESTED_WORKTREE_REMOVAL_PREFIX } from '../shared/worktree/nested-removal'

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('recoverPartialLocalWorktreeRemoval', () => {
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

      const result = await recoverPartialLocalWorktreeRemoval({
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
        {},
        undefined
      )
      expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
        ['worktree', 'prune'],
        expect.anything()
      )
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['branch', '-d', '--', 'delete-e2e-held-cwd'],
        expect.objectContaining({ cwd: 'C:/repo' })
      )
      expect(result).toEqual({})
    })
  })

  it('finishes a clean non-force deletion after Git leaves a Windows directory behind', async () => {
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('git worktree remove failed'), {
        stderr:
          "error: failed to delete 'C:/repo/worktree/delete-e2e-held-cwd': Directory not empty"
      })

      const result = await recoverPartialLocalWorktreeRemoval({
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
        {},
        undefined
      )
      expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
        ['worktree', 'prune'],
        expect.anything()
      )
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['branch', '-d', '--', 'delete-e2e-held-cwd'],
        expect.objectContaining({ cwd: 'C:/repo' })
      )
      expect(result).toEqual({})
    })
  })

  it('rejects native recovery without pruning or another pass when deletion is cancelled', async () => {
    const native = await vi.importActual<typeof LocalWorktreeFilesystem>(
      './local-worktree-filesystem'
    )
    removeLocalWorktreePathMock.mockImplementationOnce(native.removeLocalWorktreePath)
    const controller = new AbortController()
    const closeWatcher = vi.fn().mockResolvedValue(undefined)
    hostRmMock.mockImplementationOnce(async () => {
      controller.abort()
      throw Object.assign(new Error('file held open'), { code: 'EBUSY' })
    })
    await withPlatform('win32', async () => {
      await expect(
        recoverPartialLocalWorktreeRemoval({
          error: new Error('Git deregistered but left the checkout'),
          force: true,
          canonicalWorktreePath: 'C:/repo/worktree/feature',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
          deleteBranch: false,
          closeWatcher,
          signal: controller.signal
        })
      ).rejects.toThrow(/aborted/i)
      expect(removeLocalWorktreePathMock).toHaveBeenCalledWith(
        'C:/repo/worktree/feature',
        {},
        controller.signal
      )
      expect(closeWatcher).toHaveBeenCalledOnce()
      expect(hostRmMock).toHaveBeenCalledOnce()
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })

  it('does not recursively delete while watcher teardown remains unconfirmed', async () => {
    await withPlatform('win32', async () => {
      const watcherError = new Error('file watcher process did not exit after termination deadline')

      await expect(
        recoverPartialLocalWorktreeRemoval({
          error: new Error('git worktree remove failed'),
          force: true,
          canonicalWorktreePath: 'C:/repo/worktree/feature',
          repoPath: 'C:/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
          deleteBranch: true,
          closeWatcher: vi.fn().mockRejectedValue(watcherError)
        })
      ).rejects.toBe(watcherError)

      expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })

  it('recovers localized Windows failures after Git already removed the registration', async () => {
    await withPlatform('win32', async () => {
      const result = await recoverPartialLocalWorktreeRemoval({
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

      expect(removeLocalWorktreePathMock).toHaveBeenCalledWith(
        'C:/repo/worktree/feature',
        {},
        undefined
      )
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
        recoverPartialLocalWorktreeRemoval({
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

  it('finishes a macOS deletion Git deregistered before failing with Directory not empty', async () => {
    await withPlatform('darwin', async () => {
      const closeWatcher = vi.fn().mockResolvedValue(undefined)

      const result = await recoverPartialLocalWorktreeRemoval({
        error: Object.assign(new Error('git worktree remove failed'), {
          stderr:
            "error: failed to delete '/Users/dev/orca/workspaces/feature': Directory not empty"
        }),
        force: true,
        canonicalWorktreePath: '/Users/dev/orca/workspaces/feature',
        repoPath: '/Users/dev/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
        deleteBranch: true,
        closeWatcher
      })

      expect(closeWatcher).toHaveBeenCalledWith('/Users/dev/orca/workspaces/feature')
      expect(removeLocalWorktreePathMock).toHaveBeenCalledWith(
        '/Users/dev/orca/workspaces/feature',
        {},
        undefined
      )
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['branch', '-d', '--', 'feature'],
        expect.objectContaining({ cwd: '/Users/dev/repo' })
      )
      expect(result).toEqual({})
    })
  })

  it('leaves an orphaned checkout to the orphan cleanup instead of deleting it', async () => {
    await withPlatform('darwin', async () => {
      const closeWatcher = vi.fn().mockResolvedValue(undefined)

      await expect(
        recoverPartialLocalWorktreeRemoval({
          error: Object.assign(new Error('git worktree remove failed'), {
            stderr: "fatal: '/Users/dev/orca/workspaces/feature' is not a working tree"
          }),
          force: true,
          canonicalWorktreePath: '/Users/dev/orca/workspaces/feature',
          repoPath: '/Users/dev/repo',
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

  it('does not delete a checkout that now contains a registered worktree', async () => {
    await withPlatform('darwin', async () => {
      listWorktreesStrictMock.mockResolvedValue([
        {
          path: '/Users/dev/orca/workspaces/feature/nested',
          head: 'def456',
          branch: 'refs/heads/nested',
          isBare: false,
          isMainWorktree: false
        }
      ])
      const closeWatcher = vi.fn().mockResolvedValue(undefined)

      await expect(
        recoverPartialLocalWorktreeRemoval({
          error: Object.assign(new Error('git worktree remove failed'), {
            stderr:
              "error: failed to delete '/Users/dev/orca/workspaces/feature': Directory not empty"
          }),
          force: true,
          canonicalWorktreePath: '/Users/dev/orca/workspaces/feature',
          repoPath: '/Users/dev/repo',
          localWorktreeGitOptions: {},
          registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
          deleteBranch: true,
          closeWatcher
        })
      ).rejects.toThrow(NESTED_WORKTREE_REMOVAL_PREFIX)
      expect(closeWatcher).not.toHaveBeenCalled()
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
        recoverPartialLocalWorktreeRemoval({
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
          recoverPartialLocalWorktreeRemoval({
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
        recoverPartialLocalWorktreeRemoval({
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

describe('removeStaleLocalWorktreeRegistration', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    listWorktreesStrictMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    listWorktreesStrictMock.mockResolvedValue([])
  })

  it('prunes and strictly verifies on the selected WSL host without deleting files or branches', async () => {
    const options = { wslDistro: 'Ubuntu' }
    const result = await removeStaleLocalWorktreeRegistration({
      canonicalWorktreePath: '/home/dev/feature/.git',
      repoPath: '/home/dev/repo',
      localWorktreeGitOptions: options,
      registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
      deleteBranch: true
    })
    expect(result).toEqual({ preservedBranch: { branchName: 'feature', head: 'abc123' } })
    expect(gitExecFileAsyncMock).toHaveBeenCalledExactlyOnceWith(['worktree', 'prune'], {
      cwd: '/home/dev/repo',
      wslDistro: 'Ubuntu'
    })
    expect(listWorktreesStrictMock).toHaveBeenCalledExactlyOnceWith('/home/dev/repo', options)
    expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
  })

  it('does not override a locked missing registration', async () => {
    await expect(
      removeStaleLocalWorktreeRegistration({
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
      removeStaleLocalWorktreeRegistration({
        canonicalWorktreePath: 'C:/workspaces/feature',
        repoPath: 'C:/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'refs/heads/feature', head: 'abc123' },
        deleteBranch: true
      })
    ).rejects.toThrow('Git still has stale worktree registration')
  })
})
