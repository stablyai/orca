import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonWithHeadersMock, resolveGiteaIssueSourceMock } = vi.hoisted(() => ({
  requestGiteaJsonWithHeadersMock: vi.fn(),
  resolveGiteaIssueSourceMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJsonWithHeaders: requestGiteaJsonWithHeadersMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

import { listGiteaPullRequests } from './pull-request-list'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

function rawPull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    html_url: `https://git.example.com/team/widgets/pulls/${number}`,
    updated_at: '2026-05-15T00:00:00Z',
    user: { login: 'octo' },
    labels: [{ name: 'bug' }],
    head: { ref: `feature-${number}`, sha: 'abc', repo: { full_name: 'team/widgets' } },
    base: { ref: 'main', repo: { full_name: 'team/widgets' } },
    ...overrides
  }
}

describe('listGiteaPullRequests', () => {
  beforeEach(() => {
    requestGiteaJsonWithHeadersMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
  })

  it('lists opened pull requests as state=open and maps them to work items', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [rawPull(7)],
      headers: { 'x-total-count': '1' }
    })

    await expect(listGiteaPullRequests('/repo', 'opened')).resolves.toMatchObject({
      items: [
        {
          id: 'gitea-pr-team/widgets-7',
          type: 'pr',
          number: 7,
          title: 'PR 7',
          state: 'open',
          url: 'https://git.example.com/team/widgets/pulls/7',
          labels: ['bug'],
          author: 'octo',
          branchName: 'feature-7',
          baseRefName: 'main',
          repoId: 'team/widgets'
        }
      ],
      page: 1,
      perPage: 20,
      totalCount: 1,
      totalPages: 1
    })
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'open', page: 1, limit: 20 })
      })
    )
  })

  it('requests closed pull requests with state=closed', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [rawPull(3, { state: 'closed' })],
      headers: { 'x-total-count': '1' }
    })

    const result = await listGiteaPullRequests('/repo', 'closed')

    expect(result.items.map((item) => item.state)).toEqual(['closed'])
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'closed' })
      })
    )
  })

  it('lists merged pull requests by querying closed and keeping merged or has_merged rows', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [
        rawPull(1, { state: 'closed', merged: true }),
        rawPull(2, { state: 'closed', merged: false }),
        rawPull(3, { state: 'closed', has_merged: true })
      ],
      headers: { 'x-total-count': '3' }
    })

    const result = await listGiteaPullRequests('/repo', 'merged', 1, 20)

    expect(result.items.map((item) => item.number)).toEqual([1, 3])
    expect(result.items.map((item) => item.state)).toEqual(['merged', 'merged'])
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'closed' })
      })
    )
  })

  it('requests every pull request state when the filter is all', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [],
      headers: { 'x-total-count': '0' }
    })

    await listGiteaPullRequests('/repo', 'all')

    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'all' })
      })
    )
  })

  it('passes a trimmed search query as q', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [],
      headers: { 'x-total-count': '0' }
    })

    await listGiteaPullRequests('/repo', 'opened', 2, 10, 'origin', '  widgets  ')

    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'origin', null, {})
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'open', page: 2, limit: 10, q: 'widgets' })
      })
    )
  })

  it('computes total pages from the x-total-count header', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [rawPull(1)],
      headers: { 'x-total-count': '41' }
    })

    await expect(listGiteaPullRequests('/repo', 'opened', 1, 20)).resolves.toMatchObject({
      page: 1,
      perPage: 20,
      totalCount: 41,
      totalPages: 3
    })
  })

  it('returns a not-found result when the repository cannot be resolved', async () => {
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: null, fellBack: false })

    await expect(listGiteaPullRequests('/repo')).resolves.toMatchObject({
      items: [],
      page: 1,
      perPage: 20,
      totalCount: 0,
      totalPages: 0,
      error: { type: 'not_found' }
    })
    expect(requestGiteaJsonWithHeadersMock).not.toHaveBeenCalled()
  })
})
