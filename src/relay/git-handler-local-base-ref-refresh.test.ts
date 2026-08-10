import { describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import type { GitExec } from './git-handler-ops'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'

const params = {
  repoPath: '/repo',
  fullRef: 'refs/heads/main',
  remoteTrackingRef: 'refs/remotes/origin/main',
  timeoutMs: 10_000
}

function commandResult(stdout = ''): { stdout: string; stderr: string } {
  return { stdout, stderr: '' }
}

describe('refreshLocalBaseRefForWorktreeCreateOp timeout', () => {
  it('passes each subprocess the remaining refresh stage time', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const git = vi.fn<GitExec>(async (args) => {
      now += 1_000
      if (args[0] === 'rev-parse' && args[2] === 'refs/heads/main^{commit}') {
        return commandResult('local-oid\n')
      }
      if (args[0] === 'rev-parse') {
        return commandResult('remote-oid\n')
      }
      if (args[0] === 'worktree') {
        return commandResult('worktree /repo\nHEAD local-oid\nbranch refs/heads/develop\n')
      }
      return commandResult()
    })

    try {
      await refreshLocalBaseRefForWorktreeCreateOp(git, params, new GitCapabilityCache())
    } finally {
      nowSpy.mockRestore()
    }

    expect(git.mock.calls.map(([, , options]) => options?.timeout)).toEqual([
      10_000, 9_000, 8_000, 7_000, 6_000, 5_000, 4_000
    ])
  })

  it('keeps a completed subprocess result and fails before the next command', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const git = vi.fn<GitExec>().mockImplementationOnce(async () => {
      now = 11_000
      return commandResult()
    })

    try {
      await expect(
        refreshLocalBaseRefForWorktreeCreateOp(git, params, new GitCapabilityCache())
      ).rejects.toThrow('Worktree base ref refresh timed out.')
    } finally {
      nowSpy.mockRestore()
    }

    expect(git).toHaveBeenCalledTimes(1)
  })

  it('preserves an explicit timeout when the current subprocess times out', async () => {
    const git = vi
      .fn<GitExec>()
      .mockRejectedValue(Object.assign(new Error('git timed out.'), { code: 'ETIMEDOUT' }))

    await expect(
      refreshLocalBaseRefForWorktreeCreateOp(git, params, new GitCapabilityCache())
    ).rejects.toThrow('Worktree base ref refresh timed out.')
  })

  it('preserves timeout-shaped Git errors when no refresh deadline was requested', async () => {
    const error = Object.assign(new Error('proxy timed out.'), { code: 'ETIMEDOUT' })
    const git = vi.fn<GitExec>().mockRejectedValue(error)

    await expect(
      refreshLocalBaseRefForWorktreeCreateOp(
        git,
        { ...params, timeoutMs: undefined },
        new GitCapabilityCache()
      )
    ).rejects.toBe(error)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 7_200_001])(
    'rejects an invalid local base ref refresh timeout: %s',
    async (timeoutMs) => {
      const git = vi.fn<GitExec>()

      await expect(
        refreshLocalBaseRefForWorktreeCreateOp(
          git,
          { ...params, timeoutMs },
          new GitCapabilityCache()
        )
      ).rejects.toThrow('Invalid local base ref refresh timeout.')
      expect(git).not.toHaveBeenCalled()
    }
  )
})
