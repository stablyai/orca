import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { forceDeleteLocalBranch, removeWorktree } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
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

  it('keeps removal successful when branch cleanup fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGitCommands({
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
      },
      'git branch -d -- feature/test': {
        error: new Error('branch delete failed'),
        stderr: 'branch delete failed'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[git] Preserved local branch "feature/test" after removing worktree (not fully merged)',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })

  it('deletes a squash-merged branch when merging it into the base is a no-op', async () => {
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
      'git worktree list --porcelain#2': {
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
      'git rev-parse --verify --quiet HEAD^{commit}': {
        stdout: 'base123\n'
      },
      'git merge-tree --write-tree base123 refs/heads/feature/test': {
        stdout: 'tree123\n'
      },
      'git rev-parse --verify --quiet base123^{tree}': {
        stdout: 'tree123\n'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})

    const calls = getGitCalls()
    expect(calls).toContain('git branch -d -- feature/test')
    expect(calls).toContain('git merge-tree --write-tree base123 refs/heads/feature/test')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git config --remove-section branch.feature/test')
    expect(calls).not.toContain('git remote')
  })

  it('deletes a squash-merged branch with branch-only merge commits via expected head', async () => {
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
        stdout: 'target123\n'
      },
      'git merge-tree --write-tree target123 refs/heads/feature/test': {
        stdout: 'merged-tree\n'
      },
      'git rev-parse --verify --quiet target123^{tree}': {
        stdout: 'target-tree\n'
      },
      'git rev-list --right-only --merges --count target123...refs/heads/feature/test': {
        stdout: '1\n'
      },
      'git merge-base target123 refs/heads/feature/test': {
        stdout: 'base123\n'
      },
      'git diff base123 refs/heads/feature/test': {
        stdout: 'branch net diff\n'
      },
      'git patch-id --stable#1': {
        stdout: 'patch123 0000000000000000000000000000000000000000\n'
      },
      'git rev-list --ancestry-path --max-count=201 base123..target123': {
        stdout: 'squash123\n'
      },
      'git show --format= squash123': {
        stdout: 'squash diff\n'
      },
      'git patch-id --stable#2': {
        stdout: 'patch123 squash123\n'
      },
      'git merge-tree --write-tree squash123 refs/heads/feature/test': {
        stdout: 'squash-tree\n'
      },
      'git rev-parse --verify --quiet squash123^{tree}': {
        stdout: 'squash-tree\n'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})

    const calls = getGitCalls()
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git config --remove-section branch.feature/test')
    expect(gitExecFileAsyncMock.mock.calls).toContainEqual([
      ['patch-id', '--stable'],
      { cwd: '/repo', stdin: 'branch net diff\n' }
    ])
    expect(gitExecFileAsyncMock.mock.calls).toContainEqual([
      ['patch-id', '--stable'],
      { cwd: '/repo', stdin: 'squash diff\n' }
    ])
  })

  it('refreshes the saved remote base before deleting a safe-delete-rejected branch', async () => {
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
      'git worktree list --porcelain#2': {
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
      'git remote': {
        stdout: 'origin\n'
      },
      'git fetch --prune origin': {
        stdout: ''
      },
      'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}': {
        stdout: 'base123\n'
      },
      'git merge-tree --write-tree base123 refs/heads/feature/test': {
        stdout: 'tree123\n'
      },
      'git rev-parse --verify --quiet base123^{tree}': {
        stdout: 'tree123\n'
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})

    const calls = getGitCalls()
    const mergeTreeCall = 'git merge-tree --write-tree base123 refs/heads/feature/test'
    const mergeTreeIndexes = calls.flatMap((call, index) => (call === mergeTreeCall ? [index] : []))
    const fetchIndex = calls.indexOf('git fetch --prune origin')
    const updateRefIndex = calls.indexOf('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git fetch --prune origin')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(mergeTreeIndexes).toHaveLength(1)
    expect(fetchIndex).toBeLessThan(mergeTreeIndexes[0])
    expect(mergeTreeIndexes[0]).toBeLessThan(updateRefIndex)
    expectGitCallOrder(
      calls,
      'git fetch --prune origin',
      'git update-ref -d refs/heads/feature/test def456'
    )
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
      'git cherry -v base123 refs/heads/feature/test': {
        stdout: '- def456 fix: already squash-merged\n'
      },
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

  it('force-deletes a preserved branch only at its saved head', async () => {
    mockGitCommands({})

    await forceDeleteLocalBranch('/repo', 'feature/test', 'def456')

    const calls = getGitCalls()
    expect(calls).toContain('git worktree list --porcelain')
    expect(calls).toContain('git update-ref -d refs/heads/feature/test def456')
    expect(calls).toContain('git config --remove-section branch.feature/test')
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
})
