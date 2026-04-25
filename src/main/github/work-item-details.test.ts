import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('passes row type into the lookup and fetches issue comments from the issue source', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'issue:923',
      type: 'issue',
      number: 923,
      title: 'Use upstream issues',
      state: 'open',
      url: 'https://github.com/stablyai/orca/issues/923',
      labels: [],
      updatedAt: '2026-04-01T00:00:00Z',
      author: 'octocat'
    })
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ body: 'Issue body' }) })
      .mockResolvedValueOnce({ stdout: '[]' })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 923, 'issue')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923/comments?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(details?.body).toBe('Issue body')
  })
})
