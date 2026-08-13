import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./client', () => ({
  acquire: (...args: unknown[]) => acquireMock(...args),
  release: (...args: unknown[]) => releaseMock(...args),
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args),
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
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

describe('listSavedFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
  })

  it('fetches Cloud filters from /filter/my with favourites and JQL expanded', async () => {
    jiraRequestMock.mockResolvedValueOnce([
      { id: '10001', name: 'Team backlog', jql: 'project = ALP ORDER BY rank', favourite: true },
      { id: 10002, name: 'API cleanup', jql: 'labels = api' }
    ])
    const { listSavedFilters } = await import('./saved-filters')

    const filters = await listSavedFilters('site-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: expect.objectContaining({ id: 'site-1' }) }),
      '/rest/api/3/filter/my?expand=jql&includeFavourites=true'
    )
    expect(filters).toEqual([
      {
        id: '10002',
        name: 'API cleanup',
        jql: 'labels = api',
        siteId: 'site-1',
        siteName: 'Example Jira',
        favourite: undefined
      },
      {
        id: '10001',
        name: 'Team backlog',
        jql: 'project = ALP ORDER BY rank',
        siteId: 'site-1',
        siteName: 'Example Jira',
        favourite: true
      }
    ])
  })

  it('fetches Server/DC filters from the REST v2 favourite resource', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce([
      { id: '9001', name: 'My sprint', jql: 'sprint in openSprints()' }
    ])
    const { listSavedFilters } = await import('./saved-filters')

    const filters = await listSavedFilters('server-1')

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: expect.objectContaining({ authType: 'server' }) }),
      '/rest/api/2/filter/favourite?expand=jql'
    )
    expect(filters).toEqual([
      {
        id: '9001',
        name: 'My sprint',
        jql: 'sprint in openSprints()',
        siteId: 'server-1',
        siteName: 'Self-hosted Jira',
        favourite: undefined
      }
    ])
  })

  it('drops filters without executable JQL and non-array payloads', async () => {
    jiraRequestMock.mockResolvedValueOnce([
      { id: '1', name: 'No JQL exposed' },
      { id: '2', name: '  ', jql: 'labels = api' },
      { id: '3', name: 'Blank JQL', jql: '   ' },
      { id: '4', name: 'Valid', jql: 'assignee = currentUser()' }
    ])
    const { listSavedFilters } = await import('./saved-filters')

    const filters = await listSavedFilters('site-1')

    expect(filters.map((filter) => filter.id)).toEqual(['4'])
  })

  it('clears the token and rethrows on auth failure for an explicit single site', async () => {
    const error = new Error('Unauthorized')
    isAuthErrorMock.mockReturnValue(true)
    jiraRequestMock.mockRejectedValueOnce(error)
    const { listSavedFilters } = await import('./saved-filters')

    await expect(listSavedFilters('site-1')).rejects.toThrow('Unauthorized')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
    expect(releaseMock).toHaveBeenCalled()
  })

  it("keeps healthy sites' filters when one site fails under an 'all' fan-out", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
      jiraRequestMock
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([{ id: '7', name: 'Alive', jql: 'project = OK' }])
      const { listSavedFilters } = await import('./saved-filters')

      const filters = await listSavedFilters('all')

      expect(filters.map((filter) => filter.id)).toEqual(['7'])
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('dedupes filters by site and id across owned + favourite overlap', async () => {
    jiraRequestMock.mockResolvedValueOnce([
      { id: '10001', name: 'Team backlog', jql: 'project = ALP', favourite: true },
      { id: '10001', name: 'Team backlog', jql: 'project = ALP', favourite: true }
    ])
    const { listSavedFilters } = await import('./saved-filters')

    const filters = await listSavedFilters('site-1')

    expect(filters).toHaveLength(1)
  })

  it('returns an empty list when no site is connected', async () => {
    getClientsMock.mockReturnValue([])
    const { listSavedFilters } = await import('./saved-filters')

    await expect(listSavedFilters()).resolves.toEqual([])
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })
})
