import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
import { clearGitCapabilityStateForTests } from '../command-runner/host-routing/git-capability-state'
import { gitPush } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearGitCapabilityStateForTests()
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
})
