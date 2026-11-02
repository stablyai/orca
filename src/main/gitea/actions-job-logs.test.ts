import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaTextResultMock, resolveGiteaIssueSourceMock, repoRefForProjectMock } =
  vi.hoisted(() => ({
    requestGiteaTextResultMock: vi.fn(),
    resolveGiteaIssueSourceMock: vi.fn(),
    repoRefForProjectMock: vi.fn()
  }))

vi.mock('./client', () => ({
  requestGiteaTextResult: requestGiteaTextResultMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./work-item-queries', () => ({
  repoRefForProject: repoRefForProjectMock
}))

import { getGiteaJobTrace, retryJob } from './actions-job-logs'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

describe('getGiteaJobTrace', () => {
  beforeEach(() => {
    requestGiteaTextResultMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    repoRefForProjectMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
  })

  it('returns a bounded plain-text trace', async () => {
    requestGiteaTextResultMock.mockResolvedValue({
      status: 200,
      text: 'building\n##[error] compile failed\n'
    })

    await expect(getGiteaJobTrace('/repo', 41, 'origin', 'conn-1')).resolves.toEqual({
      ok: true,
      trace: expect.stringContaining('compile failed')
    })
    expect(requestGiteaTextResultMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/actions/jobs/41/logs',
      { timeoutMs: 60_000 }
    )
  })

  it('returns an empty trace when the job log is missing', async () => {
    requestGiteaTextResultMock.mockResolvedValue({ status: 404, text: null })

    await expect(getGiteaJobTrace('/repo', 41)).resolves.toEqual({ ok: true, trace: '' })
  })
})

describe('retryJob', () => {
  it('reports that single-job retry is unsupported', async () => {
    requestGiteaTextResultMock.mockClear()
    await expect(retryJob('/repo', 41)).resolves.toEqual({
      ok: false,
      error: 'Retrying a single Gitea Actions job is not supported.',
      errorCode: 'gitea.jobRetryUnsupported'
    })
    expect(requestGiteaTextResultMock).not.toHaveBeenCalled()
  })
})
