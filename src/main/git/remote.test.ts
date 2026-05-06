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

  it('pushes with --set-upstream regardless of publish flag', async () => {
    // Why: every push uses --set-upstream so worktrees that were created
    // tracking the BASE ref (origin/main) get their upstream repointed to
    // origin/<branch> on first push. Without that the local branch keeps
    // tracking origin/main forever and the UI's ahead/behind read via
    // @{u} measures "ahead of base" rather than "ahead of remote branch".
    // Both publish=true and publish=false take the same path now; the
    // parameter is preserved in the signature for IPC compatibility but
    // is no longer load-bearing.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitPush('/repo', true)
    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('maps non-fast-forward push failures to an actionable message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

    await expect(gitPush('/repo', false)).rejects.toThrow(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
  })

  it('passes through clean tail line when push error does not match known patterns', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(
      new Error('Command failed: git push\nfatal: something obscure happened')
    )

    await expect(gitPush('/repo', false)).rejects.toThrow('fatal: something obscure happened')
  })

  it('strips embedded credentials from push error messages', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(
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
    gitExecFileAsyncMock.mockRejectedValueOnce(
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
    gitExecFileAsyncMock.mockRejectedValueOnce('string')

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
