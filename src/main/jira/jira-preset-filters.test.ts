import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssueFilter } from '../../shared/jira-types'
import type { JiraClientForSite } from './authenticated-request'

const { getClients, jiraRequest, clearToken } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn(),
  clearToken: vi.fn()
}))
vi.mock('./client', () => ({ getClients, clearToken, isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest,
  JiraApiError: class extends Error {}
}))
vi.mock('./jira-agile-fields', () => ({
  getAgileFieldIds: async () => ({}),
  agileFieldIdList: () => []
}))
vi.mock('./request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))

function site(id: string, authType: 'cloud' | 'server' = 'cloud'): JiraClientForSite {
  return {
    site: {
      id,
      authType,
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: id,
      accountId: 'me'
    },
    authorization: 'fixture'
  }
}

function issue(key: string, done: boolean, resolved: boolean, updated = '2020-01-01') {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      updated,
      status: {
        name: done ? 'Complete' : 'Reopened',
        statusCategory: { key: done ? 'done' : 'indeterminate' }
      },
      resolution: resolved ? { name: 'Fixed' } : null
    }
  }
}

function requestJql(init: { body?: string } | undefined): string {
  const body: unknown = JSON.parse(init?.body ?? '{}')
  if (
    typeof body !== 'object' ||
    body === null ||
    !('jql' in body) ||
    typeof body.jql !== 'string'
  ) {
    throw new Error('Expected search body')
  }
  return body.jql
}

describe('Jira preset filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([site('cloud')])
    jiraRequest.mockReset()
  })
  it('keeps Cloud All project bounds when combining workflow statuses and current sprint', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.startsWith('/rest/api/3/project/search')) {
        return { values: [{ id: '1', key: 'ABC', name: 'Example' }], isLast: true }
      }
      expect(requestJql(init)).toBe(
        'project in ("1") AND statusCategory != Done AND status in ("Blocked") AND sprint in openSprints() ORDER BY updated DESC'
      )
      return { issues: [] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(
      listIssues('all', 20, 'cloud', false, { statuses: ['Blocked'], currentSprint: true })
    ).resolves.toEqual([])
    expect(jiraRequest).toHaveBeenCalledTimes(2)
  })

  it.each<JiraIssueFilter>(['assigned', 'reported', 'done'])(
    '%s follows status when resolution is stale',
    async (filter) => {
      const fixtures = [issue('ALP-1', true, false), issue('ALP-2', false, true)]
      jiraRequest.mockImplementation(async (_entry, _path, init) => {
        const jql = requestJql(init)
        return {
          issues: fixtures.filter((item) => {
            if (jql.includes('statusCategory = Done')) {
              return item.fields.status.statusCategory.key === 'done'
            }
            if (jql.includes('statusCategory != Done')) {
              return item.fields.status.statusCategory.key !== 'done'
            }
            return jql.includes('IS NOT EMPTY')
              ? item.fields.resolution !== null
              : item.fields.resolution === null
          })
        }
      })
      const { listIssues } = await import('./jira-issue-search')
      await expect(listIssues(filter, 20, 'cloud')).resolves.toMatchObject([
        { key: filter === 'done' ? 'ALP-1' : 'ALP-2' }
      ])
    }
  )

  it('bounds Cloud All with every project, preserving old open issues', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return path.includes('startAt=0')
          ? { maxResults: 1, total: 2, values: [{ id: '10', key: 'ALP' }] }
          : { maxResults: 1, total: 2, values: [{ id: '20', key: 'BRV' }] }
      }
      const jql = requestJql(init)
      if (!jql.includes('project in (')) {
        throw new Error('Unbounded JQL queries are not allowed here')
      }
      expect(jql).toContain('statusCategory != Done')
      expect(jql).toContain('"10"')
      expect(jql).toContain('"20"')
      expect(jql).not.toMatch(/updated\s*[><=]|resolution/)
      return { issues: [issue('ALP-2', false, true)] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).resolves.toMatchObject([
      { key: 'ALP-2', updatedAt: '2020-01-01' }
    ])
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it('composes multi-status filters inside the bounded Cloud All query', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return { isLast: true, values: [{ id: '10', key: 'APP' }] }
      }
      expect(requestJql(init)).toBe(
        'project in ("10") AND statusCategory != Done AND status in ("Blocked", "In Progress") ORDER BY updated DESC'
      )
      return { issues: [issue('APP-1', false, false)] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(
      listIssues('all', 20, 'cloud', true, { statuses: ['Blocked', 'In Progress'] })
    ).resolves.toMatchObject([{ key: 'APP-1' }])
    expect(jiraRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps Server/DC All on classic search without project discovery', async () => {
    getClients.mockReturnValue([site('server', 'server')])
    jiraRequest.mockResolvedValue({ issues: [] })
    const { listIssues } = await import('./jira-issue-search')
    await listIssues('all', 20, 'server')
    expect(jiraRequest).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/search',
      expect.objectContaining({
        body: expect.stringContaining('statusCategory != Done ORDER BY updated DESC')
      })
    )
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('does not send an unbounded search when the Cloud account has no projects', async () => {
    jiraRequest.mockResolvedValue({ values: [], isLast: true })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).resolves.toEqual([])
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(jiraRequest.mock.calls[0][1]).toContain('/project/search')
  })

  it('surfaces project discovery failures instead of returning an empty list', async () => {
    jiraRequest.mockImplementation(async (_entry, path) => {
      if (path.includes('/project/search')) {
        throw new Error('Project discovery forbidden')
      }
      return { issues: [] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).rejects.toThrow('Project discovery forbidden')
  })

  it('leaves caller JQL unchanged even when it equals the All preset', async () => {
    jiraRequest.mockResolvedValue({ issues: [] })
    const { searchIssues } = await import('./jira-issue-search')
    const jql = 'statusCategory != Done ORDER BY updated DESC'
    await searchIssues(jql, 20, 'cloud')
    expect(requestJql(jiraRequest.mock.calls[0][2])).toBe(jql)
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('merges project batches by update time before applying the result limit', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return {
          isLast: true,
          values: Array.from({ length: 101 }, (_, index) => ({ id: String(index) }))
        }
      }
      return {
        issues: [
          requestJql(init).includes('"100"')
            ? issue('LAST-1', false, false, '2026-10-01')
            : issue('FIRST-1', false, false, '2020-01-01')
        ]
      }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 1, 'cloud')).resolves.toMatchObject([{ key: 'LAST-1' }])
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it('follows partial issue pages in every batch before merging the newest results', async () => {
    const requests: { batch: string; token: string | undefined; limit: number }[] = []
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return {
          isLast: true,
          values: Array.from({ length: 101 }, (_, index) => ({ id: String(index) }))
        }
      }
      const body = JSON.parse(init.body)
      const batch = body.jql.includes('"100"') ? 'last' : 'first'
      requests.push({ batch, token: body.nextPageToken, limit: body.maxResults })
      if (!body.nextPageToken) {
        return {
          issues: [
            issue(`${batch}-1`, false, false, batch === 'last' ? '2026-10-10' : '2026-10-09')
          ],
          nextPageToken: `${batch}-next`
        }
      }
      expect(body.nextPageToken).toBe(`${batch}-next`)
      return {
        issues: [
          issue(`${batch}-2`, false, false, batch === 'last' ? '2026-10-08' : '2026-10-07'),
          issue(`${batch}-3`, false, false, '2020-01-01')
        ],
        isLast: true
      }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 3, 'cloud')).resolves.toMatchObject([
      { key: 'last-1' },
      { key: 'first-1' },
      { key: 'last-2' }
    ])
    expect(requests).toEqual([
      { batch: 'first', token: undefined, limit: 3 },
      { batch: 'first', token: 'first-next', limit: 2 },
      { batch: 'last', token: undefined, limit: 3 },
      { batch: 'last', token: 'last-next', limit: 2 }
    ])
  })

  it('continues across an empty issue page with a next token', async () => {
    jiraRequest
      .mockResolvedValueOnce({ values: [{ id: '10' }], isLast: true })
      .mockResolvedValueOnce({ issues: [], nextPageToken: 'next' })
      .mockResolvedValueOnce({ issues: [issue('ALP-1', false, false)], isLast: true })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 3, 'cloud')).resolves.toMatchObject([{ key: 'ALP-1' }])
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it.each([
    { isLast: true },
    { issues: null, isLast: true },
    { issues: [issue('ALP-1', false, false)], isLast: false },
    { issues: [], isLast: false, nextPageToken: '' }
  ])('rejects a malformed or incomplete Cloud issue page: %j', async (response) => {
    jiraRequest
      .mockResolvedValueOnce({ values: [{ id: '10' }], isLast: true })
      .mockResolvedValueOnce(response)
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 3, 'cloud')).rejects.toThrow(/issue page/)
    expect(jiraRequest).toHaveBeenCalledTimes(2)
  })

  it('stops when a batch reaches the requested limit even if another token exists', async () => {
    jiraRequest
      .mockResolvedValueOnce({ values: [{ id: '10' }], isLast: true })
      .mockResolvedValueOnce({ issues: [issue('ALP-1', false, false)], nextPageToken: 'unused' })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 1, 'cloud')).resolves.toMatchObject([{ key: 'ALP-1' }])
    expect(jiraRequest).toHaveBeenCalledTimes(2)
  })

  it('surfaces a repeated issue page token instead of looping or returning an incomplete list', async () => {
    jiraRequest
      .mockResolvedValueOnce({ values: [{ id: '10' }], isLast: true })
      .mockResolvedValue({ issues: [], nextPageToken: 'repeat' })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 3, 'cloud')).rejects.toThrow('repeated issue page token')
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it('bounds empty token pages with a safety limit', async () => {
    let token = 0
    jiraRequest.mockImplementation(async (_entry, path) =>
      path.includes('/project/search')
        ? { values: [{ id: '10' }], isLast: true }
        : { issues: [], nextPageToken: String(++token) }
    )
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 3, 'cloud')).rejects.toThrow(
      'issue search exceeded the page limit'
    )
    expect(jiraRequest).toHaveBeenCalledTimes(101)
  })

  it('keeps subsequent issue pages under the original search deadline', async () => {
    vi.useFakeTimers()
    try {
      let firstSignal: AbortSignal | undefined
      jiraRequest
        .mockResolvedValueOnce({ values: [{ id: '10' }], isLast: true })
        .mockImplementationOnce(async (_entry, _path, init: { signal: AbortSignal }) => {
          firstSignal = init.signal
          return { issues: [], nextPageToken: 'next' }
        })
        .mockImplementationOnce((_entry, _path, init: { signal: AbortSignal }) => {
          expect(init.signal).toBe(firstSignal)
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
        })
      const { listIssues } = await import('./jira-issue-search')
      const result = listIssues('all', 3, 'cloud').then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(jiraRequest).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restricts projects separately for each Cloud site while keeping Server search unchanged', async () => {
    getClients.mockReturnValue([site('a'), site('b'), site('server', 'server')])
    const queries = new Map<string, string>()
    jiraRequest.mockImplementation(async (entry: JiraClientForSite, path: string, init) => {
      if (path.includes('/project/search')) {
        return { isLast: true, values: [{ id: entry.site.id }] }
      }
      queries.set(entry.site.id, requestJql(init))
      return { issues: [] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await listIssues('all', 20, 'all')
    expect(queries.get('a')).toBe(
      'project in ("a") AND statusCategory != Done ORDER BY updated DESC'
    )
    expect(queries.get('b')).toBe(
      'project in ("b") AND statusCategory != Done ORDER BY updated DESC'
    )
    expect(queries.get('server')).toBe('statusCategory != Done ORDER BY updated DESC')
  })

  it.each([{ total: 2, values: [] }, { isLast: false, values: [] }, { issues: [] }])(
    'surfaces malformed or incomplete project discovery: %j',
    async (response) => {
      jiraRequest.mockResolvedValue(response)
      const { listIssues } = await import('./jira-issue-search')
      await expect(listIssues('all', 20, 'cloud')).rejects.toThrow(/project page/)
      expect(jiraRequest).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects page-limit exhaustion instead of silently omitting projects', async () => {
    jiraRequest.mockResolvedValue({ isLast: false, maxResults: 1, values: [{ id: '10' }] })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).rejects.toThrow('exceeded the page limit')
    expect(jiraRequest).toHaveBeenCalledTimes(100)
  })

  it('puts project discovery under the same abortable deadline as issue search', async () => {
    vi.useFakeTimers()
    try {
      jiraRequest.mockImplementation(
        (_entry, _path, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
      )
      const { listIssues } = await import('./jira-issue-search')
      const result = listIssues('all', 20, 'cloud').then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(jiraRequest).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
