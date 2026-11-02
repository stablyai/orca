import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import type { JiraRecord } from './jira-record-pages'
import { listIssues, searchIssues } from './jira-issue-search'

const { getClientsMock, jiraRequestMock } = vi.hoisted(() => ({
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClientsMock(...args),
  clearToken: vi.fn(),
  isAuthError: () => false
}))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

type CloudSearchBody = {
  jql: string
  fields: string[]
  maxResults: number
  nextPageToken?: string
}
type SearchPageRequest = {
  batch: 'first' | 'last'
  fields: string[]
  limit: number
  token: string | undefined
}

function parseCloudSearchBody(init?: RequestInit): CloudSearchBody {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON search request')
  }
  const body: unknown = JSON.parse(init.body)
  if (
    !body ||
    typeof body !== 'object' ||
    !('jql' in body) ||
    typeof body.jql !== 'string' ||
    !('fields' in body) ||
    !Array.isArray(body.fields) ||
    !body.fields.every((field): field is string => typeof field === 'string') ||
    !('maxResults' in body) ||
    typeof body.maxResults !== 'number'
  ) {
    throw new Error('Expected JQL, fields, result limit, and an optional string token')
  }
  const nextPageToken = 'nextPageToken' in body ? body.nextPageToken : undefined
  if (nextPageToken !== undefined && typeof nextPageToken !== 'string') {
    throw new Error('Expected a string page token')
  }
  return {
    jql: body.jql,
    fields: body.fields,
    maxResults: body.maxResults,
    ...(nextPageToken !== undefined ? { nextPageToken } : {})
  }
}

function client(id: string): JiraClientForSite {
  return {
    site: {
      id,
      authType: 'cloud',
      siteUrl: `https://${id}.atlassian.net`,
      email: '',
      displayName: id,
      accountId: 'viewer'
    },
    authorization: 'Basic composition-fixture'
  }
}

function planningIssue(
  key: string,
  updated: string,
  points: number,
  laterPage = false
): JiraRecord {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      created: '2020-01-01T00:00:00Z',
      updated,
      project: { id: key.startsWith('LAST') ? '100' : '0', key: key.split('-')[0] },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      customfield_7: [
        { name: 'Previous sprint', state: 'closed' },
        { name: `${key} sprint`, state: 'active' }
      ],
      customfield_8: laterPage ? null : points,
      customfield_9: laterPage ? points : null,
      timeoriginalestimate: 3600,
      timeestimate: 0,
      parent: { key: 'PLAN-1000', fields: { summary: 'Planning epic' } }
    }
  }
}

beforeEach(() => {
  getClientsMock.mockReset()
  jiraRequestMock.mockReset()
})

describe('Cloud search with optional planning field discovery', () => {
  it.each([3, 6])(
    'preserves fields across project batches/pages and returns the newest %i issues',
    async (limit) => {
      const entry = client(`cloud-columns-limit-${limit}`)
      getClientsMock.mockReturnValue([entry])
      const requests: SearchPageRequest[] = []
      const projectStarts: number[] = []
      const customFields = ['customfield_7', 'customfield_8', 'customfield_9']
      const firstPage = [planningIssue('FIRST-1', '2026-10-09T12:00:00Z', 5)]
      const lastPage = [planningIssue('LAST-1', '2026-10-10T12:00:00Z', 8)]
      const firstContinuation = [
        planningIssue('FIRST-2', '2026-10-07T12:00:00Z', 0, true),
        planningIssue('FIRST-3', '2020-01-01T00:00:00Z', 2, true)
      ]
      const lastContinuation = [
        planningIssue('LAST-2', '2026-10-08T12:00:00Z', 0, true),
        planningIssue('LAST-3', '2020-01-02T00:00:00Z', 3, true)
      ]
      jiraRequestMock.mockImplementation(
        async (requestEntry: JiraClientForSite, path: string, init?: RequestInit) => {
          expect(requestEntry).toBe(entry)
          if (path === '/rest/api/3/field') {
            return [
              {
                id: customFields[0],
                name: 'Sprint',
                schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
              },
              {
                id: customFields[1],
                name: 'Story Points',
                schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
              },
              {
                id: customFields[2],
                name: 'Story point estimate',
                schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' }
              }
            ]
          }
          if (path.startsWith('/rest/api/3/project/search?')) {
            const startAt = Number(new URL(path, entry.site.siteUrl).searchParams.get('startAt'))
            projectStarts.push(startAt)
            expect([0, 100]).toContain(startAt)
            return startAt === 0
              ? {
                  maxResults: 100,
                  total: 101,
                  values: Array.from({ length: 100 }, (_, index) => ({ id: String(index) }))
                }
              : { maxResults: 100, total: 101, values: [{ id: '100' }] }
          }
          expect(path).toBe('/rest/api/3/search/jql')
          expect(init?.method).toBe('POST')
          expect(init?.signal).toBeInstanceOf(AbortSignal)
          const body = parseCloudSearchBody(init)
          expect(body.jql).toContain('project in (')
          expect(body.jql).toContain('statusCategory != Done')
          expect(body.jql).not.toMatch(/resolution|updated\s*[><=]/)
          expect(body.fields).toEqual(expect.arrayContaining(customFields))
          expect(body.fields).toEqual(
            expect.arrayContaining(['parent', 'timeoriginalestimate', 'timeestimate'])
          )
          expect(body.fields).not.toContain('description')
          const batch = body.jql.includes('"100"') ? 'last' : 'first'
          if (batch === 'first') {
            expect(body.jql).toContain('"0"')
            expect(body.jql).toContain('"99"')
            expect(body.jql).not.toContain('"100"')
          } else {
            expect(body.jql).toContain('project in ("100")')
          }
          requests.push({
            batch,
            fields: body.fields,
            limit: body.maxResults,
            token: body.nextPageToken
          })
          if (!body.nextPageToken) {
            return {
              issues: batch === 'first' ? firstPage : lastPage,
              nextPageToken: `${batch}-next`
            }
          }
          expect(body.nextPageToken).toBe(`${batch}-next`)
          return {
            issues: batch === 'first' ? firstContinuation : lastContinuation,
            isLast: true
          }
        }
      )

      const results = await listIssues('all', limit, entry.site.id, true)

      expect(results).toHaveLength(limit)
      expect(results.slice(0, 3).map((item) => item.key)).toEqual(['LAST-1', 'FIRST-1', 'LAST-2'])
      expect(projectStarts).toEqual([0, 100])
      expect(
        requests.map(({ batch, limit: pageLimit, token }) => ({ batch, limit: pageLimit, token }))
      ).toEqual([
        { batch: 'first', token: undefined, limit },
        { batch: 'first', token: 'first-next', limit: limit - 1 },
        { batch: 'last', token: undefined, limit },
        { batch: 'last', token: 'last-next', limit: limit - 1 }
      ])
      expect(
        requests.every(
          (request) => JSON.stringify(request.fields) === JSON.stringify(requests[0]?.fields)
        )
      ).toBe(true)
      expect(
        jiraRequestMock.mock.calls.filter((call) => call[1] === '/rest/api/3/field')
      ).toHaveLength(1)
      expect(jiraRequestMock).toHaveBeenCalledTimes(7)
      expect(results.find((item) => item.key === 'LAST-2')).toMatchObject({
        siteId: entry.site.id,
        sprint: 'LAST-2 sprint',
        storyPoints: 0,
        originalEstimateSeconds: 3600,
        remainingEstimateSeconds: 0,
        parent: { key: 'PLAN-1000', title: 'Planning epic' }
      })
      if (limit === 6) {
        const expectedPoints: Record<string, number> = {
          'FIRST-1': 5,
          'FIRST-2': 0,
          'FIRST-3': 2,
          'LAST-1': 8,
          'LAST-2': 0,
          'LAST-3': 3
        }
        for (const item of results) {
          expect(item.sprint).toBe(`${item.key} sprint`)
          expect(item.storyPoints).toBe(expectedPoints[item.key])
        }
      }
    }
  )

  it.each(['list', 'search'] as const)(
    'rejects disconnected strict %s reads before field discovery or any other request',
    async (kind) => {
      getClientsMock.mockReturnValue([])
      const request =
        kind === 'list'
          ? listIssues('all', 3, 'strict-disconnected-cloud', true)
          : searchIssues('project = PLAN', 3, 'strict-disconnected-cloud', undefined, true)
      await expect(request).rejects.toThrow('one connected site ID')
      expect(getClientsMock).toHaveBeenCalledWith('strict-disconnected-cloud')
      expect(jiraRequestMock).not.toHaveBeenCalled()
    }
  )
})
