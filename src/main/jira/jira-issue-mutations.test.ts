import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  jiraRequestBinaryMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  jiraRequestBinaryMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
  JiraApiError: class JiraApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  }
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
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

describe('Jira issue mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
    jiraRequestMock.mockReset()
  })

  it('sends plain-text bodies and v2 paths for self-hosted issue creation', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: '' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'server-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      description: 'Body text'
    })

    const [, path, init] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/2/issue')
    const body = JSON.parse((init as { body: string }).body) as {
      fields: { description: unknown }
    }
    // REST v2 rejects ADF documents; the description must stay a plain string.
    expect(body.fields.description).toBe('Body text')
  })

  it('shapes user-typed create fields into Jira user objects', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'site-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { reporter: 'account-9', customfield_1: 'plain', customfield_2: ['a', 'b'] },
      userFieldKeys: ['reporter', 'customfield_2']
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    // A bare string here is what Jira reports back as "Reporter is required".
    expect(body.fields.reporter).toEqual({ accountId: 'account-9' })
    expect(body.fields.customfield_2).toEqual([{ accountId: 'a' }, { accountId: 'b' }])
    expect(body.fields.customfield_1).toBe('plain')
  })

  it('shapes user-typed create fields by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'server-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { reporter: 'wquintal' },
      userFieldKeys: ['reporter']
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    expect(body.fields.reporter).toEqual({ name: 'wquintal' })
  })

  it('leaves create fields untouched when no user keys are declared', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ id: '1', key: 'ALP-1', self: 'https://x' })
    const { createIssue } = await import('./issues')

    await createIssue({
      siteId: 'site-1',
      projectId: '10000',
      issueTypeId: '10001',
      title: 'Fix auth',
      customFields: { customfield_1: { id: '3' } }
    })

    const [, , init] = jiraRequestMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body) as { fields: Record<string, unknown> }
    expect(body.fields.customfield_1).toEqual({ id: '3' })
  })

  it('unassigns by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValue(null)
    const { updateIssue } = await import('./issues')

    await updateIssue('ALP-1', { assigneeAccountId: null }, 'server-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/issue/ALP-1/assignee',
      expect.objectContaining({ body: JSON.stringify({ name: null }) })
    )
  })

  it('assigns by username on self-hosted sites', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValue(null)
    const { updateIssue } = await import('./issues')

    await updateIssue('ALP-1', { assigneeAccountId: 'wquintal' }, 'server-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/issue/ALP-1/assignee',
      expect.objectContaining({ body: JSON.stringify({ name: 'wquintal' }) })
    )
  })
})
