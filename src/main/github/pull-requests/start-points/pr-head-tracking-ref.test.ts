import { describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { fetchGitHubPullRequestHeadRef } from './pr-head-tracking-ref'

describe('fetchPrHeadTrackingRef', () => {
  it('rejects invalid PR numbers and option-shaped remotes before running git', async () => {
    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 4.2)
    ).rejects.toThrow('Invalid pull request number')
    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, '--upload-pack=x', 42)
    ).rejects.toThrow('must not start with "-"')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
