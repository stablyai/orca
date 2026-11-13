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

vi.mock('./local-worktree-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalWorktreeFilesystem>()
  return {
    ...actual,
    prepareLocalWorktreeFilesystem: async (
      ...args: Parameters<typeof actual.prepareLocalWorktreeFilesystem>
    ) => {
      const filesystem = await actual.prepareLocalWorktreeFilesystem(...args)
      return { ...filesystem, remove: (path: string) => removeLocalWorktreePathMock(path, args[1]) }
    }
  }
})

vi.mock('../../filesystem/asar-transparent-fs', () => ({ rm: hostRmMock }))

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  recoverPartialLocalWorktreeRemoval,
  removeStaleLocalWorktreeRegistration
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
