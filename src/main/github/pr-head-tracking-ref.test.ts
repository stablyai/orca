import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { fetchGitHubPullRequestHeadRef, fetchPrHeadTrackingRef } from './pr-head-tracking-ref'

const ORIGIN_URL = 'https://github.com/acme/widgets.git'

describe('fetchPrHeadTrackingRef', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_URL}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  })

  it('throws for an SSH repo named only by executionHostId', async () => {
    await expect(
      fetchPrHeadTrackingRef({ path: '/repo', executionHostId: 'ssh:gpu' }, 'origin', 'feature/x')
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('fails the pull-head fetch when the remote is not configured', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error("fatal: No such remote 'origin'")
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 42)
    ).rejects.toThrow('Remote "origin" is not configured.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      expect.anything()
    )
  })

  it('rejects a GitHub pull-head fetch for an SSH repo', async () => {
    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: 'conn-1' }, 'origin', 42)
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

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
