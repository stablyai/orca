import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const { clearTokenMock, getClientsMock, isAuthErrorMock, jiraRequestMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
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

describe('Jira issue operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
  })

  it('surfaces Jira credential decrypt errors on active issue, metadata, and mutation paths', async () => {
    const error = new Error(credentialDecryptionMessage('Jira'))
    getClientsMock.mockImplementation(() => {
      throw error
    })
    const { createIssue, getIssue, listIssueTypes, listProjects, searchIssues } =
      await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'site-1')).rejects.toThrow(error.message)
    await expect(getIssue('ALP-1', 'site-1')).rejects.toThrow(error.message)
    await expect(listProjects('site-1')).rejects.toThrow(error.message)
    await expect(listIssueTypes('10000', 'site-1')).rejects.toThrow(error.message)
    await expect(
      createIssue({
        siteId: 'site-1',
        projectId: '10000',
        issueTypeId: '10001',
        title: 'Fix auth'
      })
    ).rejects.toThrow(error.message)
  })

  it('rejects single-site search failures so the UI can surface them', async () => {
    getClientsMock.mockReturnValue([makeEntry('site-1')])
    jiraRequestMock.mockRejectedValueOnce(new Error('Forbidden'))
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'site-1')).rejects.toThrow('Forbidden')
  })

  it('includes Jira status codes in surfaced single-site search failures', async () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 })
    getClientsMock.mockReturnValue([makeEntry('site-1')])
    jiraRequestMock.mockRejectedValueOnce(error)
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'site-1')).rejects.toThrow(
      'Error 403: Forbidden'
    )
  })

  it('keeps healthy sites when one site fails under an "all" search', async () => {
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    jiraRequestMock.mockRejectedValueOnce(new Error('Forbidden')).mockResolvedValueOnce({
      issues: [{ id: '1', key: 'BRV-1', fields: { summary: 'Healthy' } }]
    })
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'all')).resolves.toMatchObject([
      { key: 'BRV-1', title: 'Healthy' }
    ])
  })

  it('keeps healthy sites when the saved selection fans out without an explicit site', async () => {
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    jiraRequestMock.mockRejectedValueOnce(new Error('Forbidden')).mockResolvedValueOnce({
      issues: [{ id: '1', key: 'BRV-1', fields: { summary: 'Healthy' } }]
    })
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20)).resolves.toMatchObject([
      { key: 'BRV-1', title: 'Healthy' }
    ])
  })

  it('surfaces an error when every site fails under an "all" search', async () => {
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    jiraRequestMock
      .mockRejectedValueOnce(new Error('Forbidden'))
      .mockRejectedValueOnce(new Error('Service Unavailable'))
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'all')).rejects.toThrow('Forbidden')
  })

  it('prefers operational failures when every "all" search site fails', async () => {
    const authError = new Error('Unauthorized')
    const operationalError = new Error('Service Unavailable')
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    isAuthErrorMock.mockImplementation((error) => error === authError)
    jiraRequestMock.mockRejectedValueOnce(authError).mockRejectedValueOnce(operationalError)
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = ALP', 20, 'all')).rejects.toThrow('Service Unavailable')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
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

  it('maps Jira ADF descriptions into Markdown blocks and lists', async () => {
    const { mapJiraIssue } = await import('./issues')

    const issue = mapJiraIssue(makeEntry().site, {
      id: 'issue-33',
      key: 'PM-33',
      fields: {
        summary: 'BE - Tests E2E/Cleanup',
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'História' },
                { type: 'hardBreak' },
                { type: 'text', text: 'Coverage ownership' }
              ]
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'admin - JOAO' }]
                    }
                  ]
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'attachment batch - JOAO' }]
                    }
                  ]
                }
              ]
            },
            {
              type: 'orderedList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'API module' }]
                    }
                  ]
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'UI module' }]
                    }
                  ]
                }
              ]
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Done' }]
            }
          ]
        },
        project: { id: '10000', key: 'PM', name: 'Project Management' },
        issuetype: { id: '10001', name: 'Task' },
        status: {
          id: '1',
          name: 'To Do',
          statusCategory: { key: 'new', name: 'To Do' }
        },
        labels: [],
        created: '2026-06-18T00:00:00.000Z',
        updated: '2026-06-18T00:00:00.000Z'
      }
    })

    expect(issue.description).toBe(
      [
        'História',
        'Coverage ownership',
        '',
        '- admin - JOAO',
        '- attachment batch - JOAO',
        '',
        '1. API module',
        '2. UI module',
        '',
        'Done'
      ].join('\n')
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

  describe('getProjectStatusOrder', () => {
    it('returns an empty order when no clients are available', async () => {
      getClientsMock.mockReturnValue([])
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
        statusIdsByColumn: []
      })
    })

    it('returns an empty order when an omitted site resolves to multiple clients', async () => {
      getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP')).resolves.toEqual({ statusIdsByColumn: [] })
      expect(jiraRequestMock).not.toHaveBeenCalled()
    })

    it('returns an empty order when the project has no accessible board', async () => {
      jiraRequestMock.mockResolvedValueOnce({ values: [] })
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP & OPS', 'site-1')).resolves.toEqual({
        statusIdsByColumn: []
      })
      expect(String(jiraRequestMock.mock.calls[0][1])).toContain(
        '/rest/agile/1.0/board?projectKeyOrId=ALP+%26+OPS&maxResults=2'
      )
    })

    it('keeps alphabetical fallback when a project has multiple boards', async () => {
      jiraRequestMock.mockResolvedValueOnce({
        total: 2,
        values: [{ id: 42 }, { id: 43 }]
      })
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
        statusIdsByColumn: []
      })
      expect(jiraRequestMock).toHaveBeenCalledTimes(1)
    })

    it('keeps alphabetical fallback when Jira reports another board page', async () => {
      jiraRequestMock.mockResolvedValueOnce({
        isLast: false,
        values: [{ id: 42 }]
      })
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
        statusIdsByColumn: []
      })
      expect(jiraRequestMock).toHaveBeenCalledTimes(1)
    })

    it('returns status IDs grouped by Jira board column order', async () => {
      jiraRequestMock
        .mockResolvedValueOnce({ total: 1, values: [{ id: 42 }] })
        .mockResolvedValueOnce({
          columnConfig: {
            columns: [
              { statuses: [{ id: '1' }, { id: '2' }] },
              { statuses: [{ id: '3' }, { id: '2' }] },
              { statuses: [] }
            ]
          }
        })
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
        statusIdsByColumn: [['1', '2'], ['3']]
      })
      expect(jiraRequestMock.mock.calls[1]?.[1]).toBe('/rest/agile/1.0/board/42/configuration')
    })

    it('clears the token and surfaces credential failures', async () => {
      const authError = new Error('Unauthorized')
      isAuthErrorMock.mockReturnValue(true)
      jiraRequestMock.mockRejectedValueOnce(authError)
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).rejects.toThrow('Unauthorized')
      expect(clearTokenMock).toHaveBeenCalledWith('site-1')
    })

    it('falls back to an empty order on operational errors', async () => {
      jiraRequestMock.mockRejectedValueOnce(new Error('Service Unavailable'))
      const { getProjectStatusOrder } = await import('./issues')

      await expect(getProjectStatusOrder('ALP', 'site-1')).resolves.toEqual({
        statusIdsByColumn: []
      })
    })
  })
})
