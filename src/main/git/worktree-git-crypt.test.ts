import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: vi.fn().mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { shareGitCryptStateWithWorktree } from '../../shared/git-crypt-worktree-state'

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
    if (
      pathValue === REPO_GIT_DIR ||
      pathValue === REPO_GIT_CRYPT ||
      pathValue === join(REPO, 'git-crypt')
    ) {
      return directory
    }
    throw enoent()
  })
}

function resolveLockIdentity(commonDir = REPO_GIT_DIR): void {
  gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${commonDir}\n` })
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
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    gitExecFileAsyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
    statMock.mockReset()
    symlinkMock.mockReset().mockResolvedValue(undefined)
    cpMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps plain repository creation on the normal checkout path', async () => {
    statMock.mockRejectedValue(enoent())
    resolveLockIdentity()
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    finishRegularCreation()

    await addWorktree(REPO, WORKTREE, BRANCH, 'origin/main')

    expect(
      gitExecFileAsyncMock.mock.calls.find(
        (call) => call[0][0] === 'worktree' && call[0][1] === 'add'
      )
    ).toEqual([
      ['worktree', 'add', '--no-track', '-b', BRANCH, WORKTREE, 'refs/remotes/origin/main'],
      { cwd: REPO, timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
    expect(symlinkMock).not.toHaveBeenCalled()
    expect(cpMock).not.toHaveBeenCalled()
  })

  it('shares folder-source git-crypt state before running the deferred checkout', async () => {
    mockUnlockedRepo()
    resolveLockIdentity()
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout
    finishRegularCreation()

    await addWorktree(REPO, WORKTREE, BRANCH, 'origin/main')

    expect(
      gitExecFileAsyncMock.mock.calls.find(
        (call) => call[0][0] === 'worktree' && call[0][1] === 'add'
      )
    ).toEqual([
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
    expect(
      gitExecFileAsyncMock.mock.calls.find(
        (call) => call[0][0] === 'rev-parse' && call[0][1] === '--absolute-git-dir'
      )
    ).toEqual([
      ['rev-parse', '--absolute-git-dir'],
      { cwd: WORKTREE, timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
    expect(symlinkMock).toHaveBeenCalledWith(
      REPO_GIT_CRYPT,
      join(WORKTREE_GIT_DIR, 'git-crypt'),
      expect.stringMatching(/^(dir|junction)$/)
    )
    expect(gitExecFileAsyncMock.mock.calls.find((call) => call[0][0] === 'checkout')).toEqual([
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
    resolveLockIdentity('/main/.git')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout

    await addWorktree(REPO, WORKTREE, BRANCH, BRANCH, false, false, {
      checkoutExistingBranch: true
    })

    expect(gitExecFileAsyncMock.mock.calls[0]).toEqual([
      ['rev-parse', '--git-common-dir'],
      { cwd: REPO, timeout: WORKTREE_ADD_TIMEOUT_MS }
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
    resolveLockIdentity(REPO)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
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

  it('keeps concurrent creates on the same repository-wide authority', async () => {
    const git = vi.fn(async (_args: string[], cwd: string) => ({
      stdout: join(REPO_GIT_DIR, 'worktrees', cwd.endsWith('one') ? 'one' : 'two')
    }))

    await Promise.all([
      shareGitCryptStateWithWorktree(git, REPO_GIT_CRYPT, '/target-one'),
      shareGitCryptStateWithWorktree(git, REPO_GIT_CRYPT, '/target-two')
    ])

    expect(symlinkMock).toHaveBeenCalledTimes(2)
    expect(symlinkMock.mock.calls.map(([source]) => source)).toEqual([
      REPO_GIT_CRYPT,
      REPO_GIT_CRYPT
    ])
    expect(cpMock).not.toHaveBeenCalled()
  })

  it('fails closed without copying key material when directory links are unavailable', async () => {
    mockUnlockedRepo()
    resolveLockIdentity()
    symlinkMock.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // checkout
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('links unavailable')

    expect(cpMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('shares state but leaves checkout to sparse-worktree setup when requested', async () => {
    mockUnlockedRepo()
    resolveLockIdentity()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })

    await addWorktree(REPO, WORKTREE, BRANCH, undefined, false, true)

    const addArgs = gitExecFileAsyncMock.mock.calls.find(
      (call) => call[0][0] === 'worktree' && call[0][1] === 'add'
    )?.[0] as string[]
    expect(addArgs.filter((arg) => arg === '--no-checkout')).toHaveLength(1)
    expect(symlinkMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual(['checkout'])
  })

  it('rolls back both the worktree and fresh branch when git-crypt setup fails', async () => {
    const beforeRemoval = `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def456\nbranch refs/heads/${BRANCH}\n`
    mockUnlockedRepo()
    resolveLockIdentity()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation verification
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // update-ref

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('cannot link state')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'worktree',
      'remove',
      '--force',
      WORKTREE
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      '-d',
      `refs/heads/${BRANCH}`,
      'def456'
    ])
  })

  it('does not roll back state that worktree add failed to identify', async () => {
    mockUnlockedRepo()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${REPO_GIT_DIR}\n` }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('partial add failure')
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing branch'), { code: 1 })
      }
      return { stdout: '' }
    })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('partial add failure')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'worktree',
      'remove',
      '--force',
      WORKTREE
    ])
  })

  it('does not roll back a pre-existing same-target winner after add fails', async () => {
    const winner = `worktree ${WORKTREE}\nHEAD def456\nbranch refs/heads/${BRANCH}\n`
    mockUnlockedRepo()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${REPO_GIT_DIR}\n` }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: winner }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('same-target loser')
      }
      return { stdout: '' }
    })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('same-target loser')

    const commands = gitExecFileAsyncMock.mock.calls.map((call) => call[0])
    expect(commands).not.toContainEqual(['worktree', 'remove', '--force', WORKTREE])
    expect(commands).not.toContainEqual(['branch', '-D', '--', BRANCH])
  })

  it('preserves a same-path same-branch replacement worktree incarnation', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${REPO_GIT_DIR}\n` }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n` }
      }
      if (args[0] === 'symbolic-ref' && args[1] === '--quiet') {
        throw Object.assign(new Error('replacement has no attempt marker'), { code: 1 })
      }
      return { stdout: '' }
    })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('cleanup skipped')

    const commands = gitExecFileAsyncMock.mock.calls.map((call) => call[0])
    expect(commands).not.toContainEqual(['worktree', 'remove', '--force', WORKTREE])
    expect(commands.find((args) => args[0] === 'update-ref')).toBeUndefined()
  })

  it('preserves a branch advanced outside the matching worktree incarnation', async () => {
    mockUnlockedRepo()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    const git = gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${REPO_GIT_DIR}\n` }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n` }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: args[2] === 'HEAD^{commit}' ? 'def456\n' : 'advanced789\n' }
      }
      return { stdout: '' }
    })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('cleanup skipped')

    const commands = git.mock.calls.map((call) => call[0])
    expect(commands).not.toContainEqual(['worktree', 'remove', '--force', WORKTREE])
    expect(commands.find((args) => args[0] === 'update-ref')).toBeUndefined()
  })

  it('bounds git-crypt filesystem discovery by the whole-operation deadline', async () => {
    vi.useFakeTimers()
    resolveLockIdentity()
    statMock.mockImplementation(() => new Promise(() => {}))

    const creation = addWorktree(REPO, WORKTREE, BRANCH, undefined, false, false, {
      timeout: 25
    })
    const rejection = expect(creation).rejects.toThrow('timed out during filesystem')
    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(gitExecFileAsyncMock).toHaveBeenCalledOnce()
  })

  it('uses a fresh cleanup reserve after the operation deadline expires', async () => {
    const registered = `worktree ${WORKTREE}\0HEAD def456\0branch refs/heads/${BRANCH}\0\0`
    mockUnlockedRepo()
    symlinkMock.mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(200_000)
      throw new Error('late state-link failure')
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${REPO_GIT_DIR}\n` }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: registered }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: `${WORKTREE_GIT_DIR}\n` }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'def456\n' }
      }
      return { stdout: '' }
    })

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toThrow('late state-link failure')

    const removeCall = gitExecFileAsyncMock.mock.calls.find(
      (call) => call[0][0] === 'worktree' && call[0][1] === 'remove'
    )
    expect(removeCall?.[1]).toMatchObject({ timeout: 30_000 })
  })

  it('reports a cleanup failure when the fresh branch cannot be deleted', async () => {
    const beforeRemoval = `worktree ${REPO}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def456\nbranch refs/heads/${BRANCH}\n`
    mockUnlockedRepo()
    resolveLockIdentity()
    symlinkMock.mockRejectedValue(Object.assign(new Error('cannot link state'), { code: 'EIO' }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' }) // rollback branch OID
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${WORKTREE_GIT_DIR}\n` })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation marker
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // incarnation verification
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'def456\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('branch delete failed'))

    await expect(addWorktree(REPO, WORKTREE, BRANCH)).rejects.toMatchObject({
      cleanupFailed: true,
      message: expect.stringContaining('cleanup also failed')
    })
  })
})
