import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { gitFetch, gitPull, gitPush } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('pushes with upstream tracking when publish mode is enabled', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitPush('/repo', true)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      {
        cwd: '/repo'
      }
    )
  })

  it('maps non-fast-forward push failures to a actionable message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

    await expect(gitPush('/repo', false)).rejects.toThrow(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
  })

  it('runs pull as fast-forward only', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['pull', '--ff-only'], { cwd: '/repo' })
  })

  it('runs fetch with prune', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitFetch('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', '--prune'], { cwd: '/repo' })
  })
})
