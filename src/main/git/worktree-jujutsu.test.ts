import { describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: (value: string) => value
}))

import { addWorktree } from './worktree'

describe('addWorktree jj delegation', () => {
  it('routes a detected pure-jj repo to `jj workspace add` and skips git', async () => {
    const runJujutsuWorkspaceAdd = vi.fn().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset()

    const result = await addWorktree(
      '/repo',
      '/repo/.worktrees/feature',
      'feature',
      'origin/main',
      false,
      false,
      {
        detectJujutsuWorkspace: () => true,
        runJujutsuWorkspaceAdd
      }
    )

    expect(result).toEqual({})
    expect(runJujutsuWorkspaceAdd).toHaveBeenCalledWith({
      repoPath: '/repo',
      worktreePath: '/repo/.worktrees/feature',
      name: 'feature',
      baseRef: 'origin/main'
    })
    // The git worktree path must not run for a jj repo.
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps using git when the repo is not a pure-jj repo', async () => {
    const runJujutsuWorkspaceAdd = vi.fn().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset()
    // worktree add, then push.autoSetupRemote read (unset) + write.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await addWorktree('/repo', '/repo/.worktrees/feature', 'feature', undefined, false, false, {
      detectJujutsuWorkspace: () => false,
      runJujutsuWorkspaceAdd
    })

    expect(runJujutsuWorkspaceAdd).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['worktree', 'add', '--no-track', '-b', 'feature', '/repo/.worktrees/feature'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })
})
