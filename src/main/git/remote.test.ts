import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
import { clearGitCapabilityStateForTests } from './command-runner/git-capability-state'
import { gitFastForward, gitPush } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearGitCapabilityStateForTests()
  })

  it('does not combine remote.pushDefault with a base-branch merge target', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature/fix\n', stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--list') {
        return {
          stdout:
            'branch.feature/fix.remote\norigin\0' +
            'branch.feature/fix.merge\nrefs/heads/main\0' +
            'branch.feature/fix.base\nrefs/remotes/origin/main\0' +
            'remote.pushdefault\nfork\0',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['push', '--set-upstream', 'fork', 'HEAD:main'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('preserves redacted pre-push hook output from failed pushes', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          [
            'Command failed: git push https://x-access-token:ghp_secret@github.com/acme/repo.git HEAD',
            'husky - pre-push hook failed',
            'eslint found 2 errors',
            "error: failed to push some refs to 'https://ghp_tailSecret@github.com/acme/repo.git'"
          ].join('\n')
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toContain('husky - pre-push hook failed')
    expect(caught?.message).toContain('eslint found 2 errors')
    expect(caught?.message).not.toContain('x-access-token')
    expect(caught?.message).not.toContain('ghp_secret')
    expect(caught?.message).not.toContain('ghp_tailSecret')
  })

  it('does not retry a fast-forward-only pull that fails on divergence', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'refs/heads/feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(
        new Error('Command failed: git pull\nfatal: Not possible to fast-forward, aborting.')
      )

    await expect(gitFastForward('/repo')).rejects.toThrow('Not possible to fast-forward')
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(3)
  })
})
