import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import '../../../shared/review-head-tracking-ref'
import { fetchGitLabMergeRequestHeadRef } from './mr-head-tracking-ref'

const ORIGIN_URL = 'https://gitlab.com/acme/widgets.git'

describe('fetchGitLabMergeRequestHeadRef', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_URL}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  })

  it('fails the MR-head fetch when the remote is not configured', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error("fatal: No such remote 'origin'")
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      fetchGitLabMergeRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 42)
    ).rejects.toThrow('Remote "origin" is not configured.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      expect.anything()
    )
  })

  it('rejects a GitLab MR-head fetch for an SSH repo', async () => {
    await expect(
      fetchGitLabMergeRequestHeadRef({ path: '/repo', connectionId: 'conn-1' }, 'origin', 77)
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects invalid MR iids and option-shaped remotes before running git', async () => {
    await expect(
      fetchGitLabMergeRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 0)
    ).rejects.toThrow('Invalid merge request iid')
    await expect(
      fetchGitLabMergeRequestHeadRef({ path: '/repo', connectionId: null }, '--upload-pack=x', 42)
    ).rejects.toThrow('must not start with "-"')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
