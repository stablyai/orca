import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'

const { acquireMock, clearTokenMock, getClientsMock, isAuthErrorMock, jiraRequestMock } =
  vi.hoisted(() => ({
    acquireMock: vi.fn().mockResolvedValue(undefined),
    clearTokenMock: vi.fn(),
    getClientsMock: vi.fn(),
    isAuthErrorMock: vi.fn().mockReturnValue(false),
    jiraRequestMock: vi.fn()
  }))

vi.mock('./client', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
  release: vi.fn(),
  apiBasePath: () => '/rest/api/3',
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args),
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  jiraRequestBinary: vi.fn(),
  JiraApiError: class JiraApiError extends Error {}
}))

function makeEntry(id: string): JiraClientForSite {
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

describe('Jira search abort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    acquireMock.mockResolvedValue(undefined)
  })

  it('threads the abort signal through the request pool to every site', async () => {
    const controller = new AbortController()
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    jiraRequestMock.mockResolvedValue({ issues: [] })
    const { searchIssues } = await import('./issues')

    await searchIssues('project = ALP', 20, 'all', controller.signal)

    expect(acquireMock).toHaveBeenCalledTimes(2)
    expect(acquireMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
    for (const call of jiraRequestMock.mock.calls) {
      expect(call[2]?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse(call[2].body).fields).not.toContain('description')
    }
  })

  it('does not clear tokens when an abandoned search is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    isAuthErrorMock.mockReturnValue(true)
    getClientsMock.mockReturnValue([makeEntry('site-1')])
    jiraRequestMock.mockRejectedValueOnce(new Error('The operation was aborted'))
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'site-1', controller.signal)).rejects.toThrow(
      'aborted'
    )
    expect(clearTokenMock).not.toHaveBeenCalled()
  })
})
