import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LocalWorktreeFilesystem from './local-worktree-filesystem'

const { gitExecFileAsyncMock, listWorktreesStrictMock, removeLocalWorktreePathMock, hostRmMock } =
  vi.hoisted(() => ({
    gitExecFileAsyncMock: vi.fn(),
    listWorktreesStrictMock: vi.fn(),
    removeLocalWorktreePathMock: vi.fn(),
    hostRmMock: vi.fn()
  }))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-worktree-filesystem', () => ({
  removeLocalWorktreePath: removeLocalWorktreePathMock
}))

vi.mock('../../filesystem/asar-transparent-fs', () => ({ rm: hostRmMock }))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  recoverPartialLocalWorktreeRemoval,
  removeStaleLocalWorktreeRegistration
} from './local-worktree-removal-recovery'
import { NESTED_WORKTREE_REMOVAL_PREFIX } from '../../../shared/worktree/nested-removal'

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

  it.each(['inventory', 'watcher', 'delete', 'success'] as const)(
    'keeps partial-removal cancellation distinct from success at %s',
    async (phase) => {
      const controller = new AbortController()
      if (phase === 'inventory') {
        listWorktreesStrictMock.mockImplementationOnce(async () => {
          controller.abort()
          return []
        })
      }
      const closeWatcher = vi.fn(async () => {
        if (phase === 'watcher') {
          controller.abort()
        }
      })
      removeLocalWorktreePathMock.mockImplementationOnce(async () => {
        controller.abort()
        if (phase === 'delete') {
          throw controller.signal.reason
        }
      })
      const pending = recoverPartialLocalWorktreeRemoval({
        error: new Error('Git deregistered but left files'),
        force: true,
        canonicalWorktreePath: '/repo/feature',
        repoPath: '/repo',
        localWorktreeGitOptions: {},
        registeredWorktree: { branch: 'feature', head: 'abc' },
        deleteBranch: true,
        closeWatcher,
        signal: controller.signal
      })
      if (phase === 'success') {
        await expect(pending).resolves.toBeDefined()
      } else {
        const error = await pending.catch((error: unknown) => error)
        expect(error).toBe(controller.signal.reason)
        expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
      }
      if (phase === 'inventory' || phase === 'watcher') {
        expect(removeLocalWorktreePathMock).not.toHaveBeenCalled()
      }
    }
  )

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
