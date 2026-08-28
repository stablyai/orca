// moveWorktree: relocating a checkout via `git worktree move`.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { moveWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('moveWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs `git worktree move` from the repo with old and new paths', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await moveWorktree('/repo', '/ws/cunner', '/ws/worktree-creation-spinner')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['worktree', 'move', '/ws/cunner', '/ws/worktree-creation-spinner'],
      { cwd: '/repo' }
    )
  })

  it('propagates git failures so the caller can fall back', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: destination exists'))
    await expect(moveWorktree('/repo', '/ws/cunner', '/ws/taken')).rejects.toThrow(
      'destination exists'
    )
  })
})
