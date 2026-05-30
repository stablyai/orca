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

  it('maps required Jira create fields from create field metadata', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      startAt: 0,
      maxResults: 100,
      total: 1,
      values: [
        {
          fieldId: 'customfield_10010',
          name: 'Severity',
          required: true,
          schema: {
            type: 'option',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select'
          },
          allowedValues: [{ id: 'option-1', value: 'High' }]
        }
      ]
    })

    const { listCreateFields } = await import('./issues')

    await expect(listCreateFields('10000', '10001', 'site-1')).resolves.toEqual([
      {
        key: 'customfield_10010',
        name: 'Severity',
        required: true,
        schema: {
          type: 'option',
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
          items: undefined
        },
        allowedValues: [{ id: 'option-1', value: 'High', name: undefined }]
      }
    ])

    expect(String(jiraRequestMock.mock.calls[0][1])).toContain(
      '/rest/api/3/issue/createmeta/10000/issuetypes/10001?'
    )
  })

  it('includes custom create fields when creating Jira issues', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      id: 'issue-1',
      key: 'ALP-1',
      self: 'https://example.atlassian.net/rest/api/3/issue/issue-1'
    })

    const { createIssue } = await import('./issues')

    await expect(
      createIssue({
        siteId: 'site-1',
        projectId: '10000',
        issueTypeId: '10001',
        title: 'Fix Jira create',
        customFields: {
          customfield_10010: { id: 'option-1' }
        }
      })
    ).resolves.toEqual({
      ok: true,
      id: 'issue-1',
      key: 'ALP-1',
      url: 'https://example.atlassian.net/browse/ALP-1'
    })

    const requestInit = jiraRequestMock.mock.calls[0][2] as { body: string }
    expect(JSON.parse(requestInit.body).fields).toMatchObject({
      project: { id: '10000' },
      issuetype: { id: '10001' },
      summary: 'Fix Jira create',
      customfield_10010: { id: 'option-1' }
    })
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
