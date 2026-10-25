import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { removeWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('removeWorktree', () => {
  const beforeRemoval =
    'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'

  // Pin a non-Windows host to keep exact argv independent of core.longpaths.
  let platformSpy: MockInstance<() => NodeJS.Platform>

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
  })

  it('uses safe `branch -d` and preserves a branch with unmerged commits', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not fully merged'))

    await expect(removeWorktree('/repo', '/repo-feature', false)).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0])
    expect(calls).toContainEqual(['branch', '-d', '--', 'feature/test'])
    expect(calls).not.toContainEqual(['branch', '-D', '--', 'feature/test'])
  })

  it('deletes the branch when `branch -d` succeeds (fully merged)', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await removeWorktree('/repo', '/repo-feature', false)

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-d',
      '--',
      'feature/test'
    ])
  })

  it('reuses known removed worktree metadata instead of relisting before removal', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await removeWorktree('/repo', '/repo-feature', false, {
      knownRemovedWorktree: {
        branch: 'refs/heads/feature/test',
        head: 'def456'
      }
    })

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'remove', '/repo-feature'],
      ['branch', '-d', '--', 'feature/test']
    ])
  })

  it('prunes and retries branch deletion only when Git reports a checked-out branch', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(
      new Error("error: cannot delete branch 'feature/test' used by worktree at '/repo-stale'")
    )
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(removeWorktree('/repo', '/repo-feature', false)).resolves.toEqual({})

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'list', '--porcelain', '-z'],
      ['worktree', 'remove', '/repo-feature'],
      ['branch', '-d', '--', 'feature/test'],
      ['worktree', 'prune'],
      ['branch', '-d', '--', 'feature/test']
    ])
  })
})
