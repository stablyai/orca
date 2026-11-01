import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requestGiteaJsonMock,
  requestGiteaJsonWithHeadersMock,
  resolveGiteaIssueSourceMock,
  getTeaKnownLoginsMock
} = vi.hoisted(() => ({
  requestGiteaJsonMock: vi.fn(),
  requestGiteaJsonWithHeadersMock: vi.fn(),
  resolveGiteaIssueSourceMock: vi.fn(),
  getTeaKnownLoginsMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  requestGiteaJsonWithHeaders: requestGiteaJsonWithHeadersMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-known-host-probe', () => ({
  getTeaKnownLogins: getTeaKnownLoginsMock
}))

vi.mock('./gitea-auth-and-rate-limit', () => ({
  getAuthenticatedViewer: vi.fn()
}))

import { getGiteaWorkItemByPath, listGiteaWorkItems } from './work-item-queries'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

function rawIssue(number: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: 'details',
    state: 'open',
    html_url: `https://git.example.com/team/widgets/issues/${number}`,
    updated_at: updatedAt,
    user: { login: 'octo' },
    labels: [{ name: 'bug' }],
    ...overrides
  }
}

function rawPull(number: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    html_url: `https://git.example.com/team/widgets/pulls/${number}`,
    updated_at: updatedAt,
    user: { login: 'ada' },
    labels: [],
    head: { ref: `feature-${number}`, sha: 'abc', repo: { full_name: 'team/widgets' } },
    base: { ref: 'main', repo: { full_name: 'team/widgets' } },
    ...overrides
  }
}

describe('listGiteaWorkItems', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    requestGiteaJsonWithHeadersMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    getTeaKnownLoginsMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    getTeaKnownLoginsMock.mockResolvedValue([])
    requestGiteaJsonWithHeadersMock.mockImplementation(async (_repo, path: string) => {
      if (path.endsWith('/pulls')) {
        return {
          data: [rawPull(7, '2026-05-01T00:00:00Z')],
          headers: { 'x-total-count': '1' }
        }
      }
      return {
        data: [rawIssue(9, '2026-05-09T00:00:00Z')],
        headers: { 'x-total-count': '4' }
      }
    })
  })

  it('merges pull requests and issues sorted by updatedAt descending', async () => {
    const result = await listGiteaWorkItems('/repo', 'opened', 1, 20, 'upstream')

    expect(result.items.map((item) => ({ type: item.type, number: item.number }))).toEqual([
      { type: 'issue', number: 9 },
      { type: 'pr', number: 7 }
    ])
    expect(result).toMatchObject({ page: 1, perPage: 20, totalCount: 5, totalPages: 1 })
    const issueCall = requestGiteaJsonWithHeadersMock.mock.calls.find((call) =>
      String(call[1]).endsWith('/issues')
    )
    const pullCall = requestGiteaJsonWithHeadersMock.mock.calls.find((call) =>
      String(call[1]).endsWith('/pulls')
    )
    expect(issueCall?.[2]).toEqual(
      expect.objectContaining({
        searchParams: expect.objectContaining({ type: 'issues', state: 'open', page: 1, limit: 20 })
      })
    )
    expect(pullCall?.[2]).toEqual(
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'open', page: 1, limit: 20 })
      })
    )
    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'upstream', null, {})
  })

  it('lists only merged pull requests when the filter is merged', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [
        rawPull(1, '2026-05-02T00:00:00Z', { state: 'closed', merged: true }),
        rawPull(2, '2026-05-03T00:00:00Z', { state: 'closed', merged: false })
      ],
      headers: { 'x-total-count': '2' }
    })

    const result = await listGiteaWorkItems('/repo', 'merged')

    expect(result.items.map((item) => item.number)).toEqual([1])
    expect(result.items[0]?.state).toBe('merged')
    expect(
      requestGiteaJsonWithHeadersMock.mock.calls.every(
        (call) => !String(call[1]).endsWith('/issues')
      )
    ).toBe(true)
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls',
      expect.objectContaining({
        searchParams: expect.objectContaining({ state: 'closed' })
      })
    )
  })

  it('looks up #N on the issue index instead of text search', async () => {
    requestGiteaJsonMock.mockResolvedValue(rawIssue(23, '2026-05-04T00:00:00Z'))

    const result = await listGiteaWorkItems('/repo', 'opened', 1, 20, undefined, ' #23 ')

    expect(result.items).toMatchObject([
      { type: 'issue', number: 23, title: 'Issue 23', repoId: 'team/widgets' }
    ])
    expect(requestGiteaJsonWithHeadersMock).not.toHaveBeenCalled()
    expect(requestGiteaJsonMock).toHaveBeenCalledTimes(1)
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(repo, '/repos/team/widgets/issues/23', {
      allowNotFound: true
    })
  })

  it('maps a #N pull request and keeps it when the merged filter matches', async () => {
    requestGiteaJsonMock.mockImplementation(async (_repo, path: string) => {
      if (path.endsWith('/issues/23')) {
        return rawIssue(23, '2026-05-04T00:00:00Z', {
          title: 'Land the widget',
          state: 'closed',
          html_url: 'https://git.example.com/team/widgets/pulls/23',
          pull_request: { merged: true }
        })
      }
      return rawPull(23, '2026-05-04T00:00:00Z', {
        title: 'Land the widget',
        state: 'closed',
        merged: true
      })
    })

    const result = await listGiteaWorkItems('/repo', 'merged', 1, 20, undefined, '#23')

    expect(result.items).toMatchObject([
      { type: 'pr', number: 23, state: 'merged', branchName: 'feature-23' }
    ])
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(repo, '/repos/team/widgets/pulls/23', {
      allowNotFound: true
    })
  })

  it('passes a text query through to both listings', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [],
      headers: { 'x-total-count': '0' }
    })

    await listGiteaWorkItems('/repo', 'opened', 2, 10, undefined, 'widget bug')

    for (const call of requestGiteaJsonWithHeadersMock.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          searchParams: expect.objectContaining({ q: 'widget bug', page: 2, limit: 10 })
        })
      )
    }
  })
})

describe('getGiteaWorkItemByPath', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    getTeaKnownLoginsMock.mockReset()
    getTeaKnownLoginsMock.mockResolvedValue([
      {
        name: 'codeberg',
        url: 'https://code.example.com',
        host: 'code.example.com',
        sshHost: 'code.example.com',
        user: 'ada',
        isDefault: true
      }
    ])
  })

  it('loads an issue from the pasted host and repository path', async () => {
    requestGiteaJsonMock.mockResolvedValue(
      rawIssue(4, '2026-05-01T00:00:00Z', {
        html_url: 'https://code.example.com/acme/widgets/issues/4'
      })
    )

    const item = await getGiteaWorkItemByPath(
      '/repo',
      { host: 'code.example.com', path: 'acme/widgets' },
      4,
      'issue',
      'conn-1',
      { wslDistro: 'Ubuntu' }
    )

    expect(item).toMatchObject({
      type: 'issue',
      number: 4,
      repoId: 'acme/widgets',
      url: 'https://code.example.com/acme/widgets/issues/4'
    })
    expect(resolveGiteaIssueSourceMock).not.toHaveBeenCalled()
    expect(getTeaKnownLoginsMock).toHaveBeenCalledWith('conn-1', { wslDistro: 'Ubuntu' })
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'code.example.com',
        owner: 'acme',
        repo: 'widgets',
        loginName: 'codeberg',
        apiBaseUrl: 'https://code.example.com/api/v1'
      }),
      '/repos/acme/widgets/issues/4',
      { allowNotFound: true }
    )
  })

  it('loads a pull request from the pasted path', async () => {
    requestGiteaJsonMock.mockResolvedValue(
      rawPull(8, '2026-05-02T00:00:00Z', {
        html_url: 'https://code.example.com/acme/widgets/pulls/8'
      })
    )

    const item = await getGiteaWorkItemByPath(
      '/repo',
      { host: 'Code.Example.com', path: 'acme/widgets' },
      8,
      'pr'
    )

    expect(item).toMatchObject({ type: 'pr', number: 8, branchName: 'feature-8' })
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ loginName: 'codeberg' }),
      '/repos/acme/widgets/pulls/8',
      { allowNotFound: true }
    )
  })

  it('returns null when the issue index is a pull request or missing', async () => {
    requestGiteaJsonMock.mockResolvedValueOnce(
      rawIssue(4, '2026-05-01T00:00:00Z', { pull_request: {} })
    )
    await expect(
      getGiteaWorkItemByPath(
        '/repo',
        { host: 'code.example.com', path: 'acme/widgets' },
        4,
        'issue'
      )
    ).resolves.toBeNull()

    requestGiteaJsonMock.mockResolvedValueOnce(null)
    await expect(
      getGiteaWorkItemByPath('/repo', { host: 'code.example.com', path: 'acme/widgets' }, 4, 'pr')
    ).resolves.toBeNull()

    await expect(
      getGiteaWorkItemByPath('/repo', { host: 'code.example.com', path: 'widgets' }, 4, 'issue')
    ).resolves.toBeNull()
  })
})
