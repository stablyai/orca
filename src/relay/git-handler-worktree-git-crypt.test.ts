import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { GIT_WORKTREE_CREATE_TIMEOUT_MS } from '../shared/git-worktree-create-timeout'

const REPO = '/repo'
const WORKTREE = '/repo-feature'
const BRANCH = 'feature/test'
const GIT_CRYPT_DIR = join(REPO, '.git', 'git-crypt')
const WORKTREE_GIT_DIR = join(REPO, '.git', 'worktrees', 'repo-feature')
const directory = { isDirectory: () => true, isFile: () => false }
const file = { isDirectory: () => false, isFile: () => true }
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

function mockUnlockedRepo(): void {
  statMock.mockImplementation(async (pathValue: string) => {
    if (
      pathValue === join(REPO, '.git') ||
      pathValue === GIT_CRYPT_DIR ||
      pathValue === join(REPO, 'git-crypt')
    ) {
      return directory
    }
    throw enoent()
  })
}

function createGitMock(): ReturnType<typeof vi.fn<GitExec>> {
  return vi.fn<GitExec>(async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
      return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { stdout: 'def456\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

describe('SSH worktree creation with git-crypt', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    statMock.mockReset()
    symlinkMock.mockReset().mockResolvedValue(undefined)
    cpMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shares remote git-crypt state before deferred checkout', async () => {
    mockUnlockedRepo()
    const git = createGitMock()

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH
    })

    expect(
      git.mock.calls.find((call) => call[0][0] === 'worktree' && call[0][1] === 'add')
    ).toEqual([
      ['worktree', 'add', '--no-checkout', '--no-track', '-b', BRANCH, WORKTREE],
      REPO,
      { signal: undefined, timeout: GIT_WORKTREE_CREATE_TIMEOUT_MS }
    ])
    expect(symlinkMock).toHaveBeenCalledWith(
      GIT_CRYPT_DIR,
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.stringMatching(/^(dir|junction)$/)
    )
    expect(git).toHaveBeenCalledWith(['rev-parse', '--absolute-git-dir'], WORKTREE, {
      signal: undefined,
      timeout: GIT_WORKTREE_CREATE_TIMEOUT_MS
    })
    expect(git).toHaveBeenCalledWith(['checkout'], WORKTREE, {
      signal: undefined,
      timeout: GIT_WORKTREE_CREATE_TIMEOUT_MS
    })
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

    expect(
      git.mock.calls.find((call) => call[0][0] === 'worktree' && call[0][1] === 'add')
    ).toEqual([
      ['worktree', 'add', '--no-checkout', WORKTREE, BRANCH],
      REPO,
      { signal: undefined, timeout: GIT_WORKTREE_CREATE_TIMEOUT_MS }
    ])
    expect(git.mock.calls.map((call) => call[0])).toContainEqual(['checkout'])
  })

  it('resolves relay git-crypt authority through a linked or separate Git dir', async () => {
    statMock.mockImplementation(async (pathValue: string) => {
      if (pathValue === join(REPO, '.git')) {
        return file
      }
      if (pathValue === '/main/.git/git-crypt') {
        return directory
      }
      throw enoent()
    })
    const git = createGitMock()
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/main/.git\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing branch'), { code: 1 })
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH
    })

    expect(symlinkMock).toHaveBeenCalledWith(
      '/main/.git/git-crypt',
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.any(String)
    )
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

    expect(
      git.mock.calls.find((call) => call[0][0] === 'worktree' && call[0][1] === 'add')?.[0]
    ).toEqual(['worktree', 'add', '--no-checkout', '--no-track', '-b', BRANCH, WORKTREE])
    expect(symlinkMock).toHaveBeenCalledOnce()
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('fails closed without copying remote key material when links are unavailable', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
    const git = createGitMock()

    await expect(
      addWorktreeOp(git, {
        repoPath: REPO,
        targetDir: WORKTREE,
        branchName: BRANCH
      })
    ).rejects.toThrow('links unavailable')

    expect(cpMock).not.toHaveBeenCalled()
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
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
    expect(git.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      '-d',
      `refs/heads/${BRANCH}`,
      'def456'
    ])
  })

  it('does not roll back state that worktree add failed to identify', async () => {
    mockUnlockedRepo()
    const git = createGitMock()
    let showRefCalls = 0
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('partial add failure')
      }
      if (args[0] === 'show-ref') {
        if (showRefCalls++ === 0) {
          throw Object.assign(new Error('missing branch'), { code: 1 })
        }
        return { stdout: `${BRANCH}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH })
    ).rejects.toThrow('partial add failure')

    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'worktree',
      'remove',
      '--force',
      WORKTREE
    ])
  })

  it('does not roll back a pre-existing same-target relay winner', async () => {
    mockUnlockedRepo()
    const git = createGitMock()
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: `worktree ${WORKTREE}\nHEAD def456\nbranch refs/heads/${BRANCH}\n`,
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('same-target loser')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH })
    ).rejects.toThrow('same-target loser')

    const commands = git.mock.calls.map((call) => call[0])
    expect(commands).not.toContainEqual(['worktree', 'remove', '--force', WORKTREE])
    expect(commands).not.toContainEqual(['branch', '-D', '--', BRANCH])
  })

  it('preserves a same-path same-branch replacement worktree incarnation', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    const git = createGitMock()
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
      }
      if (args[0] === 'symbolic-ref' && args[1] === '--quiet') {
        throw Object.assign(new Error('replacement has no attempt marker'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH })
    ).rejects.toThrow('cleanup skipped')

    const commands = git.mock.calls.map((call) => call[0])
    expect(commands).not.toContainEqual(['worktree', 'remove', '--force', WORKTREE])
    expect(commands.find((args) => args[0] === 'update-ref')).toBeUndefined()
  })

  it('reports a cleanup failure when compare-and-delete preserves the branch', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    const git = createGitMock()
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'def456\n', stderr: '' }
      }
      if (args[0] === 'update-ref') {
        throw new Error('branch delete failed')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH })
    ).rejects.toThrow('cleanup also failed')
  })

  it('cancels the active child and never starts checkout after cancellation', async () => {
    mockUnlockedRepo()
    const controller = new AbortController()
    const git = createGitMock()
    git.mockImplementation(async (args, _cwd, options) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
        })
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing branch'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })

    const creation = addWorktreeOp(
      git,
      { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH },
      { signal: controller.signal }
    )
    await vi.waitFor(() =>
      expect(git.mock.calls.map((call) => call[0])).toContainEqual([
        'worktree',
        'add',
        '--no-checkout',
        '--no-track',
        '-b',
        BRANCH,
        WORKTREE
      ])
    )
    const rejection = expect(creation).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()

    await rejection
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('gives expired-deadline rollback a fresh bounded reserve', async () => {
    mockUnlockedRepo()
    symlinkMock.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(200_000)
      throw new Error('late state-link failure')
    })
    const git = createGitMock()

    await expect(
      addWorktreeOp(git, { repoPath: REPO, targetDir: WORKTREE, branchName: BRANCH })
    ).rejects.toThrow('late state-link failure')

    const removeCall = git.mock.calls.find(
      (call) => call[0][0] === 'worktree' && call[0][1] === 'remove'
    )
    expect(removeCall?.[2]).toMatchObject({ signal: undefined, timeout: 30_000 })
  })

  it('passes only the remaining operation budget to a slow checkout', async () => {
    mockUnlockedRepo()
    const git = createGitMock()
    git.mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n`, stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing branch'), { code: 1 })
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        vi.mocked(Date.now).mockReturnValue(170_000)
        return { stdout: `${WORKTREE_GIT_DIR}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await addWorktreeOp(git, {
      repoPath: REPO,
      targetDir: WORKTREE,
      branchName: BRANCH
    })

    const checkoutCall = git.mock.calls.find((call) => call[0][0] === 'checkout')
    expect(checkoutCall?.[2]).toMatchObject({ timeout: 11_000 })
  })
})
