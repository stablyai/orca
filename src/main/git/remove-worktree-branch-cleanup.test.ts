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
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { deletePreservedBranchAtHead, forceDeleteLocalBranch, removeWorktree } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

// Why: removal argv carries core.longpaths on Windows; pin a non-Windows default for exact argv.
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
    // Why: a refused `-d` is settled by the caller with the review host, never by a local merge proof.
    const calls = getGitCalls()
    expect(calls.at(-1)).toBe('git branch -d -- feature/test')
    expect(
      calls.filter((call) => /merge-tree|cherry|patch-id|fetch|update-ref/.test(call))
    ).toEqual([])

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

  it('runs a preserved-branch delete in the same per-repo queue as removal branch deletes', async () => {
    let releaseBranchDelete: () => void = () => {}
    const branchDelete = new Promise<void>((resolve) => {
      releaseBranchDelete = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'branch -d -- feature/a') {
        await branchDelete
      }
      return { stdout: '', stderr: '' }
    })

    const removal = removeWorktree('/repo', '/repo-a', false, {
      knownRemovedWorktree: { branch: 'refs/heads/feature/a', head: 'aaa', locked: false }
    })
    await vi.waitFor(() => expect(getGitCalls()).toContain('git branch -d -- feature/a'))
    const guardedDelete = deletePreservedBranchAtHead('/repo', 'feature/b', 'bbb')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getGitCalls()).not.toContain('git update-ref -d refs/heads/feature/b bbb')

    releaseBranchDelete()
    await Promise.all([removal, guardedDelete])
    expect(getGitCalls()).toContain('git update-ref -d refs/heads/feature/b bbb')
  })
})
