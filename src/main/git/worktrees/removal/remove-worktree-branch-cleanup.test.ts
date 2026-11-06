// Ref mutation tests use fictitious repositories; administrative reservations have real-Git coverage.
vi.mock('../../../../shared/git/worktrees/git-worktree-admin', () => ({
  isBranchReservedByWorktreeOperation: vi.fn().mockResolvedValue(false)
}))

import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../../source-control/resolve-git-dir', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('../../source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})
import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { forceDeleteLocalBranch } from './worktree-branch-removal'
import { removeWorktree } from './worktree-removal'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

// Pin non-Windows argv; Windows removal also sets core.longpaths.
let platformSpy: MockInstance<() => NodeJS.Platform>

beforeEach(() => {
  resetWorktreeRemovalState()
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  platformSpy.mockRestore()
})

describe('removeWorktree', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('preserves an already-merged branch when cleanup races after worktree removal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGitCommands({
      'git worktree list --porcelain -z': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain -z#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'error: the branch feature/test is not fully merged'
      },
      'git config --get branch.feature/test.base': {
        stdout: 'refs/remotes/origin/main\n'
      },
      'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
        stdout: 'base123\n'
      },
      'git rev-list --right-only --merges --count base123...refs/heads/feature/test': {
        stdout: '0\n'
      },
      'git cherry base123 refs/heads/feature/test': {
        stdout: '- def456\n'
      },
      'git rev-parse --verify --quiet HEAD^{commit}': { stdout: 'base123\n' },
      'git merge-base base123 refs/heads/feature/test': { stdout: 'base000\n' },
      'git update-ref -d refs/heads/feature/test def456': {
        error: new Error('cannot lock ref')
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Failed to delete already-merged local branch "feature/test" after removing worktree',
      expect.any(Error)
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Preserved local branch "feature/test" after removing worktree (not fully merged)',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('refuses to force-delete a preserved branch that is checked out again', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'checked out in another worktree'
    )
    expect(getGitCalls()).not.toContain('git update-ref -d refs/heads/feature/test def456')
  })

  it('restores a preserved branch when a concurrent checkout wins after deletion', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo-feature
HEAD 0000000000000000000000000000000000000000
branch refs/heads/feature/test
`
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'checked out in another worktree'
    )
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      'refs/heads/feature/test',
      'def456',
      ''
    ])
  })

  it('refuses to force-delete a preserved branch after its head changes', async () => {
    mockGitCommands({
      'git update-ref -d refs/heads/feature/test def456': {
        error: new Error('cannot lock ref')
      }
    })

    await expect(forceDeleteLocalBranch('/repo', 'feature/test', 'def456')).rejects.toThrow(
      'changed after the workspace was deleted'
    )
    expect(getGitCalls()).not.toContain('git config --remove-section branch.feature/test')
  })

  it('runs branch cleanup for one repo one removal at a time, not the checkout deletes', async () => {
    let releaseFirstBranchDelete: () => void = () => {}
    const firstBranchDelete = new Promise<void>((resolve) => {
      releaseFirstBranchDelete = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'branch -d -- feature/a') {
        await firstBranchDelete
      }
      return { stdout: '', stderr: '' }
    })

    const first = removeWorktree('/repo', '/repo-a', false, {
      knownRemovedWorktree: { branch: 'refs/heads/feature/a', head: 'aaa', locked: false }
    })
    await vi.waitFor(() => expect(getGitCalls()).toContain('git branch -d -- feature/a'))
    const second = removeWorktree('/repo', '/repo-b', false, {
      knownRemovedWorktree: { branch: 'refs/heads/feature/b', head: 'bbb', locked: false }
    })
    await vi.waitFor(() => expect(getGitCalls()).toContain('git worktree remove /repo-b'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getGitCalls()).not.toContain('git branch -d -- feature/b')

    releaseFirstBranchDelete()
    await Promise.all([first, second])
    expect(getGitCalls()).toContain('git branch -d -- feature/b')
  })
})
