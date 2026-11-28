import { beforeEach, expect, it, vi } from 'vitest'
import { JiraApiError } from './jira-api-error'

const { getClients, jiraRequest } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn()
}))
vi.mock('./client', () => ({ getClients, clearToken: vi.fn(), isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({ apiBasePath: () => '/rest/api/3', jiraRequest }))

import { searchIssues } from './jira-issue-search'

const UNBOUNDED_MESSAGE =
  'Unbounded JQL queries are not allowed here. Please add a search restriction to your query.'
const RAW_JQL = 'summary ~ "a ORDER BY b" OR statusCategory != Done ORDER BY priority DESC'
let searched: string[] = []
let projectPages = 0

function mockCloudSite(siteId: string, projectIds: string[], boundedSearchError?: Error): void {
  getClients.mockResolvedValue([
    {
      site: {
        id: siteId,
        authType: 'cloud',
        siteUrl: 'https://jira.example.com',
        email: '',
        displayName: 'cloud',
        accountId: 'me'
      },
      authorization: 'cloud'
    }
  ])
  jiraRequest.mockImplementation(async (_entry, path: string, init?: { body?: string }) => {
    if (path.endsWith('/field')) {
      return []
    }
    if (path.startsWith('/rest/api/3/project/search')) {
      projectPages += 1
      const params = new URL(path, 'https://jira.example.com').searchParams
      const startAt = Number(params.get('startAt'))
      const values = projectIds.slice(startAt, startAt + Number(params.get('maxResults')))
      return {
        startAt,
        total: projectIds.length,
        isLast: startAt + values.length >= projectIds.length,
        values: values.map((id) => ({ id, key: `P${id}` }))
      }
    }
    const jql = String(JSON.parse(init?.body ?? '{}').jql)
    searched.push(jql)
    if (!jql.startsWith('project')) {
      throw new JiraApiError(UNBOUNDED_MESSAGE, 400)
    }
    if (boundedSearchError) {
      throw boundedSearchError
    }
    return { isLast: true, issues: [{ id: '1', key: 'A-1', fields: { summary: 'One' } }] }
  })
}

beforeEach(() => {
  searched = []
  projectPages = 0
})

it('retries unbounded Cloud JQL bounded to visible projects, keeping ORDER BY outside the clause', async () => {
  mockCloudSite('small', ['10', '11'])

  const issues = await searchIssues(RAW_JQL, 30, 'small')

  expect(issues.map((issue) => issue.key)).toEqual(['A-1'])
  expect(searched).toEqual([
    RAW_JQL,
    'project in ("10", "11") AND (summary ~ "a ORDER BY b" OR statusCategory != Done) ORDER BY priority DESC'
  ])
})

it('keeps the rejection after one project page and skips later project reads for a large site', async () => {
  mockCloudSite(
    'large',
    Array.from({ length: 1000 }, (_, index) => String(index + 1))
  )

  await expect(searchIssues(RAW_JQL, 30, 'large')).rejects.toThrow(/^Error 400: Unbounded JQL/)
  await expect(searchIssues(RAW_JQL, 30, 'large')).rejects.toThrow(/^Error 400: Unbounded JQL/)
  expect(searched).toEqual([RAW_JQL, RAW_JQL])
  expect(projectPages).toBe(1)
})

it('keeps the rejection when the bounded retry fails, so the text fallback still applies', async () => {
  mockCloudSite('limited', ['10'], new JiraApiError('Rate limited', 429))

  await expect(searchIssues(RAW_JQL, 30, 'limited')).rejects.toThrow(/^Error 400: Unbounded JQL/)
  expect(searched).toHaveLength(2)
})
