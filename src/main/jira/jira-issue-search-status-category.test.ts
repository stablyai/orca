import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { JiraApiError } from './jira-api-error'
import { listIssues } from './jira-issue-search'

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

function client(id: string, authType: 'server' | 'cloud'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: `https://${id}.example.com`,
      email: '',
      displayName: id,
      accountId: 'viewer',
      authType
    },
    authorization: 'Bearer fixture'
  }
}

function mockSearch(rejection: string): string[] {
  const queries: string[] = []
  jiraRequestMock.mockImplementation(async (_entry, path: string, init?: RequestInit) => {
    if (path.endsWith('/field')) {
      return []
    }
    const { jql } = JSON.parse(String(init?.body))
    queries.push(jql)
    if (jql.includes('statusCategory')) {
      throw new JiraApiError(rejection, 400)
    }
    return { issues: [{ id: '1', key: 'OLD-1', fields: { summary: 'Legacy' } }] }
  })
  return queries
}

describe('Jira presets on servers without statusCategory', () => {
  beforeEach(() => {
    jiraRequestMock.mockReset()
  })

  it.each([
    ['all', 'resolution = Unresolved ORDER BY updated DESC'],
    ['done', 'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC']
  ] as const)('retries the %s preset with resolution', async (filter, fallback) => {
    getClientsMock.mockReturnValue([client(`legacy-${filter}`, 'server')])
    const queries = mockSearch("字段 'statusCategory' 不存在")
    const issues = await listIssues(filter, 30, `legacy-${filter}`, true)
    expect(issues.map((issue) => issue.key)).toEqual(['OLD-1'])
    expect(queries).toHaveLength(2)
    expect(queries[1]).toBe(fallback)
  })

  it('does not retry Cloud sites or unrelated Server rejections', async () => {
    getClientsMock.mockReturnValue([client('cloud-site', 'cloud')])
    const cloudQueries = mockSearch("Field 'statusCategory' does not exist")
    await expect(listIssues('assigned', 30, 'cloud-site', true)).rejects.toThrow('statusCategory')
    expect(cloudQueries).toHaveLength(1)

    getClientsMock.mockReturnValue([client('server-site', 'server')])
    const serverQueries = mockSearch("Field 'sprint' does not exist")
    await expect(
      listIssues('assigned', 30, 'server-site', true, { currentSprint: true })
    ).rejects.toThrow('sprint')
    expect(serverQueries).toHaveLength(1)
  })
})
