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

  it('pushes to origin when no upstream is configured', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('no branch'), { code: 1 }))

    await gitPush('/repo', true)

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('pushes to the configured upstream remote and branch', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'review/pr-1738\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'pr-prateek-orca\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'refs/heads/prateek/fix-sidebar-agents-toggle\n',
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.remote'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.merge'], { cwd: '/repo' }],
      [
        ['push', '--set-upstream', 'pr-prateek-orca', 'HEAD:prateek/fix-sidebar-agents-toggle'],
        { cwd: '/repo' }
      ]
    ])
  })

  it('uses an explicit push target even when it differs from the local branch name', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPush('/repo', false, {
      remoteName: 'origin',
      branchName: 'contributor/fix-sidebar'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'contributor/fix-sidebar'], { cwd: '/repo' }],
      [['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'], { cwd: '/repo' }]
    ])
  })

  it('maps non-fast-forward push failures to an actionable message', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

    await expect(gitPush('/repo', false)).rejects.toThrow(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
  })

  it('passes through clean tail line when push error does not match known patterns', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error('Command failed: git push\nfatal: something obscure happened')
      )

    await expect(gitPush('/repo', false)).rejects.toThrow('fatal: something obscure happened')
  })

  it('strips embedded credentials from push error messages', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://x-access-token:ghp_abc@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_abc')
    expect(caught?.message).not.toContain('x-access-token')
  })

  it('strips token-only credentials (https://TOKEN@host) from push error messages', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://ghp_onlyToken@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_onlyToken')
  })

  it('falls back to a generic message for non-Error rejections', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce('string')

    await expect(gitPush('/repo', false)).rejects.toThrow('Git remote operation failed.')
  })

  it("runs pull with the user's configured strategy", async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['pull'], { cwd: '/repo' })
  })

  it('normalizes pull authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitPull('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })

  it('runs fetch with prune', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitFetch('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', '--prune'], { cwd: '/repo' })
  })

  it('normalizes fetch authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitFetch('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })
})
