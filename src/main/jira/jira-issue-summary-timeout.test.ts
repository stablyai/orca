import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'
import { getJiraSummaryLookupErrorCode } from '../../shared/jira-summary-lookup'

const { acquireMock, getClientsMock, jiraRequestMock, releaseMock } = vi.hoisted(() => ({
  acquireMock: vi.fn().mockResolvedValue(undefined),
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./client', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
  release: (...args: unknown[]) => releaseMock(...args),
  apiBasePath: () => '/rest/api/3',
  clearToken: vi.fn(),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  jiraRequestBinary: vi.fn(),
  JiraApiError: class JiraApiError extends Error {}
}))

function makeEntry(): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

describe('Jira issue summary timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    jiraRequestMock.mockImplementation(() => new Promise(() => {}))
  })

  it('bounds stalled reads and releases their request slot', async () => {
    vi.useFakeTimers()
    try {
      const { getIssueSummary } = await import('./issues')
      const read = getIssueSummary('ALP-1', 'site-1')
      const rejected = expect(read).rejects.toSatisfy(
        (error: unknown) => getJiraSummaryLookupErrorCode(error) === 'read-failed'
      )

      await vi.advanceTimersByTimeAsync(30_000)

      await rejected
      expect(acquireMock).toHaveBeenCalledWith(expect.any(AbortSignal))
      expect(releaseMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
