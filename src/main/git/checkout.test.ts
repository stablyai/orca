import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, runWithGitReadCacheInvalidationMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  runWithGitReadCacheInvalidationMock: vi.fn((fn: () => unknown) => fn())
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./status', () => ({
  runWithGitReadCacheInvalidation: runWithGitReadCacheInvalidationMock
}))

import { assertValidBranchName, checkoutBranch, listLocalBranches } from './checkout'

describe('checkout', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    runWithGitReadCacheInvalidationMock.mockClear()
  })

  describe('assertValidBranchName', () => {
    it('accepts valid branch names', () => {
      expect(() => assertValidBranchName('main')).not.toThrow()
      expect(() => assertValidBranchName('feature/my-branch')).not.toThrow()
      expect(() => assertValidBranchName('release-1.0')).not.toThrow()
    })

    it('rejects empty branch name', () => {
      expect(() => assertValidBranchName('')).toThrow('invalid_branch_name')
    })

    it('rejects option-like branch names starting with -', () => {
      expect(() => assertValidBranchName('-b')).toThrow('invalid_branch_name')
      expect(() => assertValidBranchName('--orphan')).toThrow('invalid_branch_name')
    })
  })

  describe('checkoutBranch', () => {
    it('executes git checkout with safety terminator and invalidates cache', async () => {
      gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

      await checkoutBranch('/path/to/worktree', 'feature/login')

      expect(runWithGitReadCacheInvalidationMock).toHaveBeenCalledTimes(1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['checkout', 'feature/login', '--'],
        expect.objectContaining({ cwd: '/path/to/worktree' })
      )
    })

    it('rejects unsafe branch names before running git', async () => {
      await expect(checkoutBranch('/path/to/worktree', '-f')).rejects.toThrow('invalid_branch_name')
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })

  describe('listLocalBranches', () => {
    it('places checked-out branch first while keeping ref order for others', async () => {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: ' \talpha\n*\tbeta\n \tgamma\n \tdelta\n'
      })

      const result = await listLocalBranches('/path/to/worktree')

      expect(result).toEqual({
        current: 'beta',
        branches: ['beta', 'alpha', 'gamma', 'delta']
      })
    })

    it('keeps current branch at index 0 when it is already first', async () => {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: '*\tmain\n \tfeature-a\n \tfeature-b\n'
      })

      const result = await listLocalBranches('/path/to/worktree')

      expect(result).toEqual({
        current: 'main',
        branches: ['main', 'feature-a', 'feature-b']
      })
    })

    it('handles detached HEAD when no branch is marked with asterisk', async () => {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: ' \talpha\n \tbeta\n \tgamma\n'
      })

      const result = await listLocalBranches('/path/to/worktree')

      expect(result).toEqual({
        current: null,
        branches: ['alpha', 'beta', 'gamma']
      })
    })

    it('skips empty lines and malformed entries cleanly', async () => {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: '\n\n \tmain\ngarbage\n\n'
      })

      const result = await listLocalBranches('/path/to/worktree')

      expect(result).toEqual({
        current: null,
        branches: ['main']
      })
    })
  })
})
