import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

describe('getUpstreamStatus', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitUpstreamStatusReads()
  })

  it('does not hide git failures while checking an explicit publish target', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(
      Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository'
      })
    )

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).rejects.toThrow('fatal: not a git repository')
  })
})
