import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'

const { clearTokenMock, getClientsMock, jiraRequestMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
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

describe('Jira issue operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([makeEntry()])
  })

  it('paginates Jira project search results before sorting them', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({
        startAt: 0,
        maxResults: 2,
        total: 3,
        values: [
          { id: '2', key: 'BRV', name: 'Bravo' },
          { id: '3', key: 'CHR', name: 'Charlie' }
        ]
      })
      .mockResolvedValueOnce({
        startAt: 2,
        maxResults: 2,
        total: 3,
        values: [{ id: '1', key: 'ALP', name: 'Alpha' }]
      })

    const { listProjects } = await import('./issues')

    await expect(listProjects('site-1')).resolves.toMatchObject([
      { id: '1', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
      { id: '2', key: 'BRV', name: 'Bravo', siteId: 'site-1' },
      { id: '3', key: 'CHR', name: 'Charlie', siteId: 'site-1' }
    ])

    expect(jiraRequestMock).toHaveBeenCalledTimes(2)
    expect(String(jiraRequestMock.mock.calls[0][1])).toContain('startAt=0')
    expect(String(jiraRequestMock.mock.calls[1][1])).toContain('startAt=2')
  })

  it('maps create-metadata issue types from the Jira issueTypes page key', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 0,
      maxResults: 100,
      total: 1,
      issueTypes: [
        {
          id: '10001',
          name: 'Bug',
          description: 'Something is broken',
          iconUrl: 'https://example.atlassian.net/bug.svg',
          subtask: false
        }
      ]
    })

    const { listIssueTypes } = await import('./issues')

    await expect(listIssueTypes('10000', 'site-1')).resolves.toEqual([
      {
        id: '10001',
        name: 'Bug',
        description: 'Something is broken',
        iconUrl: 'https://example.atlassian.net/bug.svg',
        subtask: false
      }
    ])

    expect(String(jiraRequestMock.mock.calls[0][1])).toContain(
      '/rest/api/3/issue/createmeta/10000/issuetypes?'
    )
  })

  it('maps comments from the Jira comments page key', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      comments: [
        {
          id: 'comment-1',
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Looks reproducible.' }]
              }
            ]
          },
          created: '2026-05-30T12:00:00.000Z',
          author: { accountId: 'user-1', displayName: 'Ada' }
        }
      ]
    })

    const { getIssueComments } = await import('./issues')

    await expect(getIssueComments('ALP-1', 'site-1')).resolves.toEqual([
      {
        id: 'comment-1',
        body: 'Looks reproducible.',
        createdAt: '2026-05-30T12:00:00.000Z',
        user: { accountId: 'user-1', displayName: 'Ada', avatarUrl: undefined, email: undefined },
        updatedAt: undefined
      }
    ])
  })
})
