import { beforeEach, describe, expect, it, vi } from 'vitest'

const { glabExecFileAsyncMock, getProjectRefMock, releaseMock } = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', () => ({
  acquire: vi.fn(async () => {}),
  release: releaseMock,
  getGlabKnownHosts: vi.fn(async () => ['gitlab.com']),
  getProjectRef: getProjectRefMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: vi.fn((repoPath: string) => ({ cwd: repoPath }))
}))

import { getMergeRequestVersionHeadShas } from './merge-request-versions'

describe('getMergeRequestVersionHeadShas', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    releaseMock.mockReset()
    getProjectRefMock.mockReset()
    getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
  })

  it('reads every pushed head from the merge request diff versions', async () => {
    glabExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([
        { id: 3, head_commit_sha: 'ccc' },
        { id: 2, head_commit_sha: 'bbb' },
        { id: 1 }
      ])
    })

    await expect(getMergeRequestVersionHeadShas('/repo', 12)).resolves.toEqual(['ccc', 'bbb'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/g%2Fp/merge_requests/12/versions?per_page=100'],
      { cwd: '/repo' }
    )
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('reads nothing when the repository is not a GitLab project', async () => {
    getProjectRefMock.mockResolvedValue(null)

    await expect(getMergeRequestVersionHeadShas('/repo', 12)).resolves.toEqual([])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('releases the GitLab slot when the request fails', async () => {
    glabExecFileAsyncMock.mockRejectedValue(new Error('401'))

    await expect(getMergeRequestVersionHeadShas('/repo', 12)).rejects.toThrow('401')
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })
})
