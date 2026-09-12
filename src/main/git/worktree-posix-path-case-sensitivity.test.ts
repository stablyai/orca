/**
 * A POSIX path is case-sensitive wherever it lives, including when a Windows desktop is the one
 * looking at it. `git/worktree-path-comparison` decided that from `process.platform`, so on Windows
 * every WSL/Linux worktree path was case-folded and two distinct checkouts read as one row.
 */
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'
import { areWorktreePathsEqual, canonicalWorktreePath } from './worktree-path-comparison'
import { removeWorktree } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

describe('worktree path comparison across path syntaxes', () => {
  it('keeps two POSIX worktrees that differ only in case distinct on a Windows desktop', () => {
    expect(areWorktreePathsEqual('/home/alice/ws/Feature', '/home/alice/ws/feature', 'win32')).toBe(
      false
    )
    expect(canonicalWorktreePath('/home/alice/ws/Feature', 'win32')).not.toBe(
      canonicalWorktreePath('/home/alice/ws/feature', 'win32')
    )
  })

  it('still matches the same POSIX worktree spelled with dot segments on a Windows desktop', () => {
    expect(
      areWorktreePathsEqual('/home/alice/ws/./feature', '/home/alice/ws/x/../feature', 'win32')
    ).toBe(true)
  })

  it('still folds Windows drive paths by case and slash style', () => {
    expect(areWorktreePathsEqual('C:/Users/Bob/wt', 'c:\\Users\\bob\\wt', 'win32')).toBe(true)
    expect(areWorktreePathsEqual('C:/Users/Bob/wt', 'c:\\Users\\bob\\wt', 'darwin')).toBe(true)
  })

  it('still folds a WSL UNC path by case, which Windows resolves case-insensitively', () => {
    expect(
      areWorktreePathsEqual(
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\wt',
        '\\\\WSL.LOCALHOST\\ubuntu\\home\\alice\\wt',
        'win32'
      )
    ).toBe(true)
  })

  it('never equates a POSIX path with a Windows path', () => {
    expect(
      areWorktreePathsEqual('/home/alice/wt', '\\\\wsl.localhost\\Ubuntu\\home\\alice\\wt', 'win32')
    ).toBe(false)
    expect(areWorktreePathsEqual('/Users/bob/wt', 'C:\\Users\\bob\\wt', 'win32')).toBe(false)
  })
})

describe('removeWorktree branch selection on a Windows desktop', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      resolveGitDirMock,
      readFileMock
    })
    resetWorktreeRemovalState({
      moveWorktreeDirectoryToTrashMock,
      restoreWorktreeDirectoryFromTrashMock,
      scheduleWorktreeTrashDeletionMock
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('deletes the branch of the requested WSL worktree, not its case twin', async () => {
    const listing = `worktree /home/alice/repo
HEAD aaa111
branch refs/heads/main

worktree /home/alice/ws/Feature
HEAD bbb222
branch refs/heads/Feature

worktree /home/alice/ws/feature
HEAD ccc333
branch refs/heads/feature
`
    mockGitCommands({
      'git worktree list --porcelain -z': { stdout: listing },
      'git worktree list --porcelain': { stdout: listing }
    })

    await removeWorktree('/home/alice/repo', '/home/alice/ws/feature', true, {
      wslDistro: 'Ubuntu'
    })

    const calls = getGitCalls()
    expect(calls).toContain('git branch -d -- feature')
    expect(calls).not.toContain('git branch -d -- Feature')
  })
})
