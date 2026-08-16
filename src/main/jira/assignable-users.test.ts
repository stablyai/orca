import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const { getClientsMock, isAuthErrorMock, jiraRequestMock, acquireMock, releaseMock } = vi.hoisted(
  () => ({
    getClientsMock: vi.fn(),
    isAuthErrorMock: vi.fn(),
    jiraRequestMock: vi.fn(),
    acquireMock: vi.fn().mockResolvedValue(undefined),
    releaseMock: vi.fn()
  })
)

vi.mock('./request-queue', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
  release: (...args: unknown[]) => releaseMock(...args)
}))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: vi.fn(),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

function makeEntry(id = 'site-1'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

function makeServerEntry(id = 'server-1'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: 'Self-hosted Jira',
      accountId: 'wquintal',
      authType: 'server'
    },
    authorization: 'Bearer pat-token'
  }
}

describe('Jira assignable-user search (#4643)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
  })

  it('maps a required reporter user field with no allowedValues', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 0,
      maxResults: 100,
      total: 1,
      values: [
        {
          fieldId: 'reporter',
          name: 'Reporter',
          required: true,
          schema: { type: 'user', system: 'reporter' }
        }
      ]
    })

    const { listCreateFields } = await import('./issues')
    const fields = await listCreateFields('10000', '10001', 'site-1')
    const reporter = fields.find((field) => field.key === 'reporter')

    expect(reporter?.schema?.type).toBe('user')
    expect(reporter?.allowedValues).toBeUndefined()
  })

  describe('listAssignableUsers', () => {
    it('scopes the search to an issue key', async () => {
      jiraRequestMock.mockResolvedValueOnce([
        { accountId: 'acc-1', displayName: 'Alex Rivera', avatarUrls: {} }
      ])

      const { listAssignableUsers } = await import('./issues')
      await expect(listAssignableUsers('ALP-1', undefined, 'site-1')).resolves.toEqual([
        { accountId: 'acc-1', displayName: 'Alex Rivera', email: undefined, avatarUrl: undefined }
      ])

      const requestedUrl = String(jiraRequestMock.mock.calls[0][1])
      expect(requestedUrl).toContain('/rest/api/3/user/assignable/search?')
      expect(requestedUrl).toContain('issueKey=ALP-1')
      expect(requestedUrl).not.toContain('project=')
    })
  })

  describe('listAssignableUsersForProject', () => {
    it('scopes the search to a project when no issue exists yet', async () => {
      jiraRequestMock.mockResolvedValueOnce([
        { accountId: 'acc-1', displayName: 'Alex Rivera', avatarUrls: {} }
      ])

      const { listAssignableUsersForProject } = await import('./issues')
      await expect(listAssignableUsersForProject('10000', undefined, 'site-1')).resolves.toEqual([
        { accountId: 'acc-1', displayName: 'Alex Rivera', email: undefined, avatarUrl: undefined }
      ])

      const requestedUrl = String(jiraRequestMock.mock.calls[0][1])
      expect(requestedUrl).toContain('/rest/api/3/user/assignable/search?')
      expect(requestedUrl).toContain('project=10000')
      expect(requestedUrl).not.toContain('issueKey=')
    })

    it('forwards a query to the Cloud query parameter', async () => {
      jiraRequestMock.mockResolvedValueOnce([])

      const { listAssignableUsersForProject } = await import('./issues')
      await listAssignableUsersForProject('10000', 'Alex', 'site-1')

      const requestedUrl = String(jiraRequestMock.mock.calls[0][1])
      expect(requestedUrl).toContain('query=Alex')
    })

    it('forwards a query to the Server/DC username parameter', async () => {
      getClientsMock.mockReturnValue([makeServerEntry()])
      jiraRequestMock.mockResolvedValueOnce([])

      const { listAssignableUsersForProject } = await import('./issues')
      await listAssignableUsersForProject('10000', 'Alex', 'server-1')

      const requestedUrl = String(jiraRequestMock.mock.calls[0][1])
      expect(requestedUrl).toContain('username=Alex')
      expect(requestedUrl).not.toContain('query=Alex')
    })

    it('surfaces project-scoped lookup failures to the create form', async () => {
      const failure = new Error('Jira unavailable')
      jiraRequestMock.mockRejectedValueOnce(failure)

      const { listAssignableUsersForProject } = await import('./issues')
      await expect(listAssignableUsersForProject('10000', undefined, 'site-1')).rejects.toBe(
        failure
      )
    })
  })
})
