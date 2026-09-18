// removeWorktree: branch deletion safety after the checkout is removed.
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

import { removeWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('removeWorktree branch retention', () => {
  const beforeRemoval =
    'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
  const beforeRemovalNul = `${beforeRemoval.replaceAll('\n', '\0')}\0`
  const afterRemoval = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
  const preserved = { preservedBranch: { branchName: 'feature/test', head: 'def456' } }

  function mockRepo(
    options: { merged?: boolean; checkedOut?: boolean; prunable?: boolean; moved?: boolean } = {}
  ) {
    let pruned = false
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const command = args.join(' ')
      if (command === 'worktree list --porcelain -z') {
        return { stdout: beforeRemovalNul }
      }
      if (command === 'worktree list --porcelain') {
        return {
          stdout: options.checkedOut && !(options.prunable && pruned) ? beforeRemoval : afterRemoval
        }
      }
      if (command === 'worktree prune') {
        pruned = true
      }
      if (command === 'rev-parse --verify --quiet HEAD^{commit}') {
        return { stdout: 'abc123' }
      }
      if (command === 'merge-base abc123 def456') {
        return { stdout: options.merged ? 'def456' : 'abc123' }
      }
      if (command === 'update-ref -d refs/heads/feature/test def456' && options.moved) {
        throw new Error('reference changed')
      }
      return { stdout: '', stderr: '' }
    })
  }

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('preserves an unmerged branch without asking Git to delete against its upstream', async () => {
    mockRepo()
    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual(preserved)
    expect(
      gitExecFileAsyncMock.mock.calls.some(
        ([args]) => args[0] === 'branch' || args[0] === 'update-ref'
      )
    ).toBe(false)
  })

  it('deletes only the captured commit after proving it merged', async () => {
    mockRepo({ merged: true })
    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', 'def456'],
      expect.anything()
    )
  })

  it('preserves a branch moved after the merge proof', async () => {
    mockRepo({ merged: true, moved: true })
    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual(preserved)
  })

  it('reuses known removed worktree metadata', async () => {
    mockRepo({ merged: true })
    await removeWorktree('/repo', '/repo-feature', false, {
      knownRemovedWorktree: { branch: 'refs/heads/feature/test', head: 'def456' }
    })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).not.toContainEqual([
      'worktree',
      'list',
      '--porcelain',
      '-z'
    ])
  })

  it('prunes a stale checkout registration before deleting the merged branch', async () => {
    mockRepo({ merged: true, checkedOut: true, prunable: true })
    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual({})
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'worktree',
      'prune'
    ])
  })

  it('preserves a merged branch another live checkout still holds', async () => {
    mockRepo({ merged: true, checkedOut: true })
    await expect(removeWorktree('/repo', '/repo-feature')).resolves.toEqual(preserved)
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'update-ref')).toBe(false)
  })
})
