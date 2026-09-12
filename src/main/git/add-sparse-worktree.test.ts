import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import {
  createGitCallReader,
  createGitCommandMocker,
  expectGitCallOrder,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { addSparseWorktree } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
})

describe('addSparseWorktree', () => {
  // Why: argv now depends on the host OS, so pin a non-Windows default or the exact-argv
  // assertions below would fail for a maintainer running vitest on Windows.
  let platformSpy: MockInstance<() => NodeJS.Platform>

  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      resolveGitDirMock
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
  })

  it('enables long paths on the Windows commands that actually write the deep checkout', async () => {
    // Why: `worktree add --no-checkout` writes nothing, so the long-path flag on it alone
    // left sparse creation failing with "Filename too long" (issue #15785).
    platformSpy.mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await addSparseWorktree('C:\\repo', 'C:\\repo-feature', 'feature/test', ['packages/web'])

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git -c core.longpaths=true sparse-checkout set -- packages/web',
        'git -c core.longpaths=true checkout feature/test'
      ])
    )
  })

  it('omits the long-path option on non-Windows hosts', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['packages/web'])

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git sparse-checkout set -- packages/web',
        'git checkout feature/test'
      ])
    )
    expect(calls.some((call) => call.includes('core.longpaths'))).toBe(false)
  })

  it('separates sparse checkout directory operands from options', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['-docs', 'src'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['sparse-checkout', 'set', '--', '-docs', 'src'],
      { cwd: '/repo-feature' }
    )
  })

  it('removes the worktree and deletes the created branch when sparse setup fails', async () => {
    mockGitCommands({
      // Why: addWorktree probes push.autoSetupRemote after `worktree add` to
      // decide whether to set it locally. Without an explicit mock the helper
      // returns empty stdout and the production code skips the `--local` write,
      // exercising the wrong branch. Throw with code 1 to mirror git's "key
      // unset" exit, which is what worktree.ts treats as "needs to be set".
      'git config --get push.autoSetupRemote': {
        error: Object.assign(new Error('key unset'), { code: 1 })
      },
      'git sparse-checkout set -- packages/web': {
        error: new Error('sparse setup failed')
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      }
    })

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['packages/web'])
    ).rejects.toThrow('sparse setup failed')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree add --no-checkout --no-track -b feature/test /repo-feature',
        'git config --get push.autoSetupRemote',
        'git config --local push.autoSetupRemote true',
        'git sparse-checkout init --cone',
        'git sparse-checkout set -- packages/web',
        'git config --local --unset-all branch.feature/test.base',
        'git worktree remove --force /repo-feature',
        'git branch -D -- feature/test'
      ])
    )
    expect(calls).not.toContain('git worktree prune')
    expectGitCallOrder(
      calls,
      'git sparse-checkout set -- packages/web',
      'git worktree remove --force /repo-feature'
    )
    expectGitCallOrder(
      calls,
      'git worktree remove --force /repo-feature',
      'git branch -D -- feature/test'
    )
  })

  it('marks cleanup failed when sparse rollback cannot clear metadata or remove the worktree', async () => {
    mockGitCommands({
      'git config --get push.autoSetupRemote': {
        error: Object.assign(new Error('key unset'), { code: 1 })
      },
      'git sparse-checkout set -- packages/web': {
        error: new Error('sparse setup failed')
      },
      'git config --local --unset-all branch.feature/test.base': {
        error: new Error('metadata cleanup failed')
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree remove --force /repo-feature': {
        error: new Error('worktree cleanup failed')
      }
    })

    const error = await addSparseWorktree('/repo', '/repo-feature', 'feature/test', [
      'packages/web'
    ]).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      cleanupFailed: true,
      message: expect.stringContaining('cleanup also failed')
    })
    const calls = getGitCalls()
    expectGitCallOrder(
      calls,
      'git config --local --unset-all branch.feature/test.base',
      'git worktree remove --force /repo-feature'
    )
  })
})
