import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, translateWslOutputPathsMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output)
}))

const { statMock, symlinkMock, cpMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  symlinkMock: vi.fn(),
  cpMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, stat: statMock, symlink: symlinkMock, cp: cpMock }
})

vi.mock('./status', () => ({
  resolveGitDir: vi.fn(),
  runWithGitReadCacheInvalidation: (operation: () => unknown) => operation()
}))

import { addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'

const REPO = '/repo'
const WORKTREE = '/repo-feature'
const BRANCH = 'feature/test'
const REPO_GIT_DIR = join(REPO, '.git')
const REPO_GIT_CRYPT = join(REPO_GIT_DIR, 'git-crypt')
const WORKTREE_GIT_DIR = join(REPO_GIT_DIR, 'worktrees', 'repo-feature')

const directory = { isDirectory: () => true, isFile: () => false }
const file = { isDirectory: () => false, isFile: () => true }
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

function mockUnlockedRepo(): void {
  statMock.mockImplementation(async (pathValue: string) => {
    if (pathValue === REPO_GIT_DIR || pathValue === REPO_GIT_CRYPT) {
      return directory
    }
    throw enoent()
  })
}

function resolveRemoteBase(): void {
  gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' })
}

function finishRegularCreation(): void {
  gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch base config
  gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote
}

describe('addWorktree on git-crypt repositories', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
    statMock.mockReset()
    symlinkMock.mockReset().mockResolvedValue(undefined)
    cpMock.mockReset().mockResolvedValue(undefined)
  })

  it('keeps plain repository creation on the normal checkout path', async () => {
    statMock.mockRejectedValue(enoent())
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    finishRegularCreation()

    await addWorktree(REPO, WORKTREE, BRANCH, 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      ['worktree', 'add', '--no-track', '-b', BRANCH, WORKTREE, 'refs/remotes/origin/main'],
      { cwd: REPO, timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
    expect(symlinkMock).not.toHaveBeenCalled()
    expect(cpMock).not.toHaveBeenCalled()
  })

  it('shares git-crypt state before running the deferred checkout', async () => {
    mockUnlockedRepo()
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout
    finishRegularCreation()

    await addWorktree(REPO, WORKTREE, BRANCH, 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      [
        'worktree',
        'add',
        '--no-checkout',
        '--no-track',
        '-b',
        BRANCH,
        WORKTREE,
        'refs/remotes/origin/main'
      ],
      { cwd: REPO, timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
    expect(gitExecFileAsyncMock.mock.calls[2]).toEqual([
      ['rev-parse', '--absolute-git-dir'],
      { cwd: WORKTREE }
    ])
    expect(symlinkMock).toHaveBeenCalledWith(
      REPO_GIT_CRYPT,
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.stringMatching(/^(dir|junction)$/)
    )
    expect(gitExecFileAsyncMock.mock.calls[3]).toEqual([
      ['checkout'],
      { cwd: WORKTREE, timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
  })

  it('resolves the common Git dir when creation starts from a linked worktree', async () => {
    statMock.mockImplementation(async (pathValue: string) => {
      if (pathValue === REPO_GIT_DIR) {
        return file
      }
      if (pathValue === '/main/.git/git-crypt') {
        return directory
      }
      throw enoent()
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '/main/.git\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout

    await addWorktree(REPO, WORKTREE, BRANCH, BRANCH, false, false, {
      checkoutExistingBranch: true
    })

    expect(gitExecFileAsyncMock.mock.calls[0]).toEqual([
      ['rev-parse', '--git-common-dir'],
      { cwd: REPO }
    ])
    expect(symlinkMock).toHaveBeenCalledWith(
      '/main/.git/git-crypt',
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.any(String)
    )
  })

  it('supports bare repositories without assuming a nested .git directory', async () => {
    statMock.mockImplementation(async (pathValue: string) => {
      if (pathValue === join(REPO, 'git-crypt')) {
        return directory
      }
      throw enoent()
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout

    await addWorktree(REPO, WORKTREE, BRANCH, BRANCH, false, false, {
      checkoutExistingBranch: true
    })

    expect(symlinkMock).toHaveBeenCalledWith(
      join(REPO, 'git-crypt'),
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.any(String)
    )
  })

  it('uses a no-clobber copy when the filesystem cannot create directory links', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })

    await addWorktree(REPO, WORKTREE, BRANCH)

    expect(cpMock).toHaveBeenCalledWith(REPO_GIT_CRYPT, join(WORKTREE_GIT_DIR, 'git-crypt'), {
      recursive: true,
      force: false,
      errorOnExist: true
    })
  })

  it('shares state but leaves checkout to sparse-worktree setup when requested', async () => {
    mockUnlockedRepo()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })

    await addWorktree(REPO, WORKTREE, BRANCH, undefined, false, true)

    const addArgs = gitExecFileAsyncMock.mock.calls[0]?.[0] as string[]
    expect(addArgs.filter((arg) => arg === '--no-checkout')).toHaveLength(1)
    expect(symlinkMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('rolls back both the worktree and fresh branch when git-crypt setup fails', async () => {
    const beforeRemoval = `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def456\nbranch refs/heads/${BRANCH}\n`
    const afterPrune = `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n`
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree prune
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: afterPrune })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -D

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('cannot link state')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'worktree',
      'remove',
      '--force',
      WORKTREE
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-D',
      '--',
      BRANCH
    ])
  })
})
