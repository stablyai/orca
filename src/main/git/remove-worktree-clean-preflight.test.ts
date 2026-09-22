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

import { resetWorktreeRemovalState } from './remove-worktree-test-harness'

import { assertWorktreeCleanForRemoval, WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS } from './worktree'

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
})

describe('assertWorktreeCleanForRemoval', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns without checking git status for force removals', async () => {
    await expect(assertWorktreeCleanForRemoval('/repo-feature', true)).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('passes when git status output is empty', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).resolves.toBeUndefined()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: '/repo-feature', timeout: WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS }
    )
  })

  it('throws a dedicated dirty/untracked error when status output is non-empty', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '?? scratch.txt\n', stderr: '' })

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).rejects.toMatchObject({
      message: 'Worktree has uncommitted or untracked changes.',
      stdout: '?? scratch.txt\n'
    })
  })

  it('ignores configured linked paths without mutating them before preflight', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '?? node_modules\0', stderr: '' })

    await expect(
      assertWorktreeCleanForRemoval('/repo-feature', false, {
        ignoredUntrackedPaths: ['node_modules']
      })
    ).resolves.toBeUndefined()

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: '/repo-feature', timeout: WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS }
    )
  })

  it('allows a shorter caller deadline for destructive preflight', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('git timed out.'))

    await expect(
      assertWorktreeCleanForRemoval('/repo-feature', false, { timeout: 25 })
    ).rejects.toThrow('git timed out.')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: '/repo-feature', timeout: 25 }
    )
  })

  it('still rejects real changes when configured linked paths are ignored', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '?? node_modules\0 M src/index.ts\0',
      stderr: ''
    })

    await expect(
      assertWorktreeCleanForRemoval('/repo-feature', false, {
        ignoredUntrackedPaths: ['node_modules']
      })
    ).rejects.toMatchObject({ message: 'Worktree has uncommitted or untracked changes.' })
  })

  it('rethrows preflight subprocess failures as-is', async () => {
    const error = Object.assign(new Error('fatal: not a git repository'), {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
    })
    gitExecFileAsyncMock.mockRejectedValueOnce(error)

    await expect(assertWorktreeCleanForRemoval('/repo-feature')).rejects.toBe(error)
  })
})
