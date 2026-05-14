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

  it('uses the collapsed GraphQL issue query as the hot path', async () => {
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
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              body: 'Issue body',
              assignees: { nodes: [{ login: 'jinjing' }] },
              participants: {
                nodes: [{ login: 'octocat', avatarUrl: 'https://x/y', name: 'Octo Cat' }]
              },
              comments: {
                nodes: [
                  {
                    databaseId: 7,
                    body: 'first',
                    createdAt: '2026-04-01T00:00:00Z',
                    url: 'https://github.com/stablyai/orca/issues/923#issuecomment-7',
                    author: { login: 'octocat', avatarUrl: 'https://x/y' }
                  }
                ]
              }
            }
          }
        }
      })
    })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(getWorkItemMock).toHaveBeenCalledWith('/repo-root', 923, 'issue')
    // Why: a single gh subprocess call replaces the previous REST + REST + GraphQL fan-out.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock.mock.calls[0][0][0]).toBe('api')
    expect(ghExecFileAsyncMock.mock.calls[0][0][1]).toBe('graphql')
    expect(details?.body).toBe('Issue body')
    expect(details?.assignees).toEqual(['jinjing'])
    expect(details?.comments).toHaveLength(1)
    expect(details?.comments[0].id).toBe(7)
    expect(details?.participants?.[0]?.login).toBe('octocat')
  })

  it('falls back to REST + GraphQL when the collapsed issue query fails', async () => {
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
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    // Collapsed GraphQL throws → fallback path picks up.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL error'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ body: 'Issue body' }) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { repository: { issue: { participants: { nodes: [] } } } }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: {} })
      })

    const details = await getWorkItemDetails('/repo-root', 923, 'issue')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/923/comments?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(details?.body).toBe('Issue body')
  })
})
