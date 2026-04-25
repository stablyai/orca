import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getIssueOwnerRepoMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  acquire: acquireMock,
  release: releaseMock
}))

import { createIssue, getIssue, listIssues } from './issues'

describe('issue source operations', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('gets a single issue from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 923,
        title: 'Use upstream issues',
        state: 'open',
        html_url: 'https://github.com/stablyai/orca/issues/923',
        labels: []
      })
    })

    await expect(getIssue('/repo-root', 923)).resolves.toMatchObject({ number: 923 })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root' }
    )
  })

  it('lists issues from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listIssues('/repo-root', 5)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=5&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('creates issues in the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 924,
        html_url: 'https://github.com/stablyai/orca/issues/924'
      })
    })

    await expect(createIssue('/repo-root', 'New issue', 'Body')).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://github.com/stablyai/orca/issues/924'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/stablyai/orca/issues',
        '--raw-field',
        'title=New issue',
        '--raw-field',
        'body=Body'
      ],
      { cwd: '/repo-root' }
    )
  })
})
