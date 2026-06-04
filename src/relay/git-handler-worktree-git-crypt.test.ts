import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, symlinkMock, cpMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  symlinkMock: vi.fn(),
  cpMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, stat: statMock, symlink: symlinkMock, cp: cpMock }
})

import type { GitExec } from './git-handler-ops'
import { addWorktreeOp } from './git-handler-worktree-ops'

const REPO = '/repo'
const WORKTREE = '/repo-feature'
const BRANCH = 'feature/test'
const GIT_CRYPT_DIR = join(REPO, '.git', 'git-crypt')
const WORKTREE_GIT_DIR = join(REPO, '.git', 'worktrees', 'repo-feature')
const directory = { isDirectory: () => true, isFile: () => false }
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

function mockUnlockedRepo(): void {
  statMock.mockImplementation(async (pathValue: string) => {
    if (pathValue === join(REPO, '.git') || pathValue === GIT_CRYPT_DIR) {
      return directory
    }
    throw enoent()
  })
}

function createGitMock(): ReturnType<typeof vi.fn<GitExec>> {
  return vi.fn<GitExec>(async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
      return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

describe('SSH worktree creation with git-crypt', () => {
  beforeEach(() => {
    statMock.mockReset()
    symlinkMock.mockReset().mockResolvedValue(undefined)
    cpMock.mockReset().mockResolvedValue(undefined)
  })

  it('shares remote git-crypt state before deferred checkout', async () => {
    mockUnlockedRepo()
    const git = createGitMock()

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH
    })

    expect(git.mock.calls[0]).toEqual([
      ['worktree', 'add', '--no-checkout', '--no-track', '-b', BRANCH, WORKTREE],
      REPO
    ])
    expect(symlinkMock).toHaveBeenCalledWith(
      GIT_CRYPT_DIR,
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.stringMatching(/^(dir|junction)$/)
    )
    expect(git.mock.calls.map((call) => call[0])).toContainEqual(['checkout'])
  })

  it('supports deferred checkout for an existing branch', async () => {
    mockUnlockedRepo()
    const git = createGitMock()

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH,
      checkoutExistingBranch: true
    })

    expect(git.mock.calls[0]).toEqual([
      ['worktree', 'add', '--no-checkout', WORKTREE, BRANCH],
      REPO
    ])
    expect(git.mock.calls.map((call) => call[0])).toContainEqual(['checkout'])
  })

  it('shares state without checkout when sparse setup owns checkout', async () => {
    mockUnlockedRepo()
    const git = createGitMock()

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH,
      noCheckout: true
    })

    expect(git.mock.calls[0]?.[0]).toEqual([
      'worktree',
      'add',
      '--no-checkout',
      '--no-track',
      '-b',
      BRANCH,
      WORKTREE
    ])
    expect(symlinkMock).toHaveBeenCalledOnce()
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('falls back to a no-clobber copy when remote links are unavailable', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
    const git = createGitMock()

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH
    })

    expect(cpMock).toHaveBeenCalledWith(GIT_CRYPT_DIR, join(WORKTREE_GIT_DIR, 'git-crypt'), {
      recursive: true,
      force: false,
      errorOnExist: true
    })
  })

  it('rolls back remote worktree and branch when state setup fails', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    const git = createGitMock()

    await expect(
      addWorktreeOp(git, {
        repoPath: REPO,
        targetDir: WORKTREE,
        branchName: BRANCH
      })
    ).rejects.toThrow('cannot link state')

    expect(git.mock.calls.map((call) => call[0])).toContainEqual([
      'worktree',
      'remove',
      '--force',
      WORKTREE
    ])
    expect(git.mock.calls.map((call) => call[0])).toContainEqual(['branch', '-D', '--', BRANCH])
  })
})
