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
      accountId: 'account-1',
      viewerUserId: 'account-1',
      deploymentType: 'cloud',
      authMode: 'basic'
    },
    authorization: 'Basic token'
  }
}

function makeServerEntry(id = 'server-1'): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: 'https://jira.example.internal',
      email: 'ada@example.internal',
      displayName: 'Example Jira Server',
      accountId: 'ada',
      viewerUserId: 'ada',
      deploymentType: 'server',
      authMode: 'basic',
      authUsername: 'ada'
    },
    authorization: 'Basic server-token'
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

  it('surfaces single-site Jira issue detail failures', async () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 })
    getClientsMock.mockReturnValue([makeEntry('site-1')])
    jiraRequestMock.mockRejectedValueOnce(error)
    const { getIssue } = await import('./issues')

    await expect(getIssue('ALP-1', 'site-1')).rejects.toThrow('Error 403: Forbidden')
  })

  it('surfaces single-site Jira metadata failures', async () => {
    const error = Object.assign(new Error('Create metadata unavailable'), { status: 500 })
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockRejectedValueOnce(error)
    const { listCreateFields } = await import('./issues')

    await expect(listCreateFields('10000', '1', 'server-1')).rejects.toThrow(
      'Error 500: Create metadata unavailable'
    )
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

  it('logs swallowed Jira project auth failures when all-sites keeps healthy sites', async () => {
    const authError = new Error('Unauthorized')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    isAuthErrorMock.mockImplementation((error) => error === authError)
    jiraRequestMock.mockRejectedValueOnce(authError).mockResolvedValueOnce({
      values: [{ id: '2', key: 'BRV', name: 'Bravo' }]
    })

    const { listProjects } = await import('./issues')

    try {
      await expect(listProjects('all')).resolves.toMatchObject([
        { id: '2', key: 'BRV', name: 'Bravo', siteId: 'site-2' }
      ])
      expect(clearTokenMock).toHaveBeenCalledWith('site-1')
      expect(warnSpy).toHaveBeenCalledWith(
        '[jira] listProjects auth failure (token cleared):',
        authError
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('surfaces an error when every all-sites Jira project fetch fails', async () => {
    const authError = new Error('Unauthorized')
    const operationalError = new Error('Service Unavailable')
    getClientsMock.mockReturnValue([makeEntry('site-1'), makeEntry('site-2')])
    isAuthErrorMock.mockImplementation((error) => error === authError)
    jiraRequestMock.mockRejectedValueOnce(authError).mockRejectedValueOnce(operationalError)
    const { listProjects } = await import('./issues')

    await expect(listProjects('all')).rejects.toThrow('Service Unavailable')
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
  })

  it('advances Jira project pagination by returned records on short pages', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({
        startAt: 0,
        maxResults: 100,
        total: 3,
        values: [{ id: '1', key: 'ALP', name: 'Alpha' }]
      })
      .mockResolvedValueOnce({
        startAt: 1,
        maxResults: 100,
        total: 3,
        values: [
          { id: '2', key: 'BRV', name: 'Bravo' },
          { id: '3', key: 'CHR', name: 'Charlie' }
        ]
      })

    const { listProjects } = await import('./issues')

    await expect(listProjects('site-1')).resolves.toMatchObject([
      { id: '1', key: 'ALP', name: 'Alpha', siteId: 'site-1' },
      { id: '2', key: 'BRV', name: 'Bravo', siteId: 'site-1' },
      { id: '3', key: 'CHR', name: 'Charlie', siteId: 'site-1' }
    ])

    expect(jiraRequestMock).toHaveBeenCalledTimes(2)
    const secondPagePath = String(jiraRequestMock.mock.calls[1][1])
    expect(new URL(secondPagePath, 'https://jira.example').searchParams.get('startAt')).toBe('1')
  })

  it('warns when Jira project pagination reaches the guard limit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    jiraRequestMock.mockImplementation(() => {
      const index = jiraRequestMock.mock.calls.length
      return Promise.resolve({
        startAt: index,
        maxResults: 1,
        total: 101,
        values: [{ id: String(index), key: `P${index}`, name: `Project ${index}` }]
      })
    })

    const { listProjects } = await import('./issues')

    try {
      await expect(listProjects('site-1')).resolves.toHaveLength(100)
      expect(jiraRequestMock).toHaveBeenCalledTimes(100)
      expect(warnSpy).toHaveBeenCalledWith(
        '[jira] fetchPagedRecords hit the pagination guard limit; results may be truncated.'
      )
    } finally {
      warnSpy.mockRestore()
    }
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

  it('advances create field pagination by returned records on short pages', async () => {
    jiraRequestMock
      .mockResolvedValueOnce({
        start: 0,
        size: 1,
        last: false,
        values: [{ fieldId: 'customfield_1', name: 'Severity' }]
      })
      .mockResolvedValueOnce({
        start: 1,
        size: 1,
        last: true,
        values: [{ fieldId: 'customfield_2', name: 'Risk' }]
      })

    const { listCreateFields } = await import('./issues')

    await expect(listCreateFields('10000', '10001', 'site-1')).resolves.toMatchObject([
      { key: 'customfield_1', name: 'Severity' },
      { key: 'customfield_2', name: 'Risk' }
    ])

    expect(jiraRequestMock).toHaveBeenCalledTimes(2)
    const secondPagePath = String(jiraRequestMock.mock.calls[1][1])
    expect(new URL(secondPagePath, 'https://jira.example').searchParams.get('startAt')).toBe('1')
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
        user: {
          userId: 'user-1',
          accountId: 'user-1',
          displayName: 'Ada',
          avatarUrl: undefined,
          email: undefined
        },
        updatedAt: undefined
      }
    ])
  })

  it('surfaces single-site Jira comment list failures', async () => {
    const error = Object.assign(new Error('Comments unavailable'), { status: 500 })
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockRejectedValueOnce(error)
    const { getIssueComments } = await import('./issues')

    await expect(getIssueComments('SRV-1', 'server-1')).rejects.toThrow(
      'Error 500: Comments unavailable'
    )
  })

  it('searches Jira Server issues through REST API v2', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({
      issues: [
        {
          id: '10001',
          key: 'SRV-1',
          fields: {
            summary: 'Server issue',
            description: 'Plain server description',
            project: { id: '10000', key: 'SRV', name: 'Server Project' },
            issuetype: { id: '1', name: 'Task' },
            status: {
              id: '3',
              name: 'In Progress',
              statusCategory: { key: 'indeterminate', name: 'In Progress' }
            },
            assignee: { name: 'ada', displayName: 'Ada Server' },
            labels: ['server'],
            created: '2026-06-01T00:00:00.000Z',
            updated: '2026-06-02T00:00:00.000Z'
          }
        }
      ]
    })

    const { searchIssues } = await import('./issues')

    await expect(searchIssues('project = SRV', 20, 'server-1')).resolves.toMatchObject([
      {
        key: 'SRV-1',
        title: 'Server issue',
        description: 'Plain server description',
        assignee: { userId: 'ada', accountId: 'ada', displayName: 'Ada Server' }
      }
    ])
    expect(jiraRequestMock.mock.calls[0][1]).toBe('/rest/api/2/search')
    expect(JSON.parse((jiraRequestMock.mock.calls[0][2] as { body: string }).body)).toMatchObject({
      jql: 'project = SRV',
      maxResults: 20
    })
  })

  it('creates Jira Server issues with plain text descriptions', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce({
      id: '10001',
      key: 'SRV-1',
      self: 'https://jira.example.internal/rest/api/2/issue/10001'
    })

    const { createIssue } = await import('./issues')

    await expect(
      createIssue({
        siteId: 'server-1',
        projectId: '10000',
        issueTypeId: '1',
        title: 'Create on Server',
        description: 'Plain text body'
      })
    ).resolves.toMatchObject({ ok: true, key: 'SRV-1' })

    expect(jiraRequestMock.mock.calls[0][1]).toBe('/rest/api/2/issue')
    expect(
      JSON.parse((jiraRequestMock.mock.calls[0][2] as { body: string }).body).fields
    ).toMatchObject({
      summary: 'Create on Server',
      description: 'Plain text body'
    })
  })

  it('updates Jira Server assignees with opaque user ids as names', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValue(undefined)

    const { updateIssue } = await import('./issues')

    await expect(updateIssue('SRV-1', { assigneeUserId: 'ada' }, 'server-1')).resolves.toEqual({
      ok: true,
      applied: ['assignee']
    })

    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: expect.objectContaining({ deploymentType: 'server' }) }),
      '/rest/api/2/issue/SRV-1/assignee',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'ada' })
      })
    )
  })

  it('does not expose Server assignable users without a username for assignment', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce([{ key: 'JIRAUSER10000', displayName: 'Display Only' }])

    const { listAssignableUsers } = await import('./issues')

    await expect(listAssignableUsers('SRV-1', 'display', 'server-1')).resolves.toEqual([])
  })

  it('rejects mixed Jira assignee identifier updates before sending requests', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    const { updateIssue } = await import('./issues')

    await expect(
      updateIssue('SRV-1', { assigneeUserId: 'ada', assigneeAccountId: 'account-1' }, 'server-1')
    ).resolves.toEqual({ ok: false, error: 'Use only one Jira assignee identifier field.' })

    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('keeps auth failures throwable when no Jira issue update step has landed', async () => {
    const authError = new Error('Unauthorized')
    getClientsMock.mockReturnValue([makeServerEntry()])
    isAuthErrorMock.mockImplementation((error) => error === authError)
    jiraRequestMock.mockRejectedValueOnce(authError)

    const { updateIssue } = await import('./issues')

    await expect(updateIssue('SRV-1', { title: 'Rename' }, 'server-1')).rejects.toThrow(
      'Unauthorized'
    )
    expect(clearTokenMock).toHaveBeenCalledTimes(1)
    expect(clearTokenMock).toHaveBeenCalledWith('server-1')
  })

  it('reports partial Jira issue updates when a later step fails', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('No assignee'))

    const { updateIssue } = await import('./issues')

    await expect(
      updateIssue('SRV-1', { title: 'Rename', assigneeUserId: 'ada' }, 'server-1')
    ).resolves.toEqual({
      ok: false,
      error: 'Updated issue fields, but failed to update assignee: No assignee',
      applied: ['fields'],
      failedStep: 'assignee'
    })

    expect(jiraRequestMock.mock.calls.map((call) => String(call[1]))).toEqual([
      '/rest/api/2/issue/SRV-1',
      '/rest/api/2/issue/SRV-1/assignee'
    ])
  })

  it('reports partial Jira issue updates when a transition fails after fields', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Transition unavailable'))

    const { updateIssue } = await import('./issues')

    await expect(
      updateIssue('SRV-1', { priorityId: '2', transitionId: '31' }, 'server-1')
    ).resolves.toEqual({
      ok: false,
      error: 'Updated issue fields, but failed to update transition: Transition unavailable',
      applied: ['fields'],
      failedStep: 'transition'
    })

    expect(jiraRequestMock.mock.calls.map((call) => String(call[1]))).toEqual([
      '/rest/api/2/issue/SRV-1',
      '/rest/api/2/issue/SRV-1/transitions'
    ])
  })

  it('uses Jira Server metadata and user endpoints', async () => {
    getClientsMock.mockReturnValue([makeServerEntry()])
    jiraRequestMock
      .mockResolvedValueOnce([{ id: '10000', key: 'SRV', name: 'Server Project' }])
      .mockResolvedValueOnce({ issueTypes: [{ id: '1', name: 'Task' }] })
      .mockResolvedValueOnce({ values: [{ fieldId: 'customfield_1', name: 'Severity' }] })
      .mockResolvedValueOnce([{ id: '2', name: 'High' }])
      .mockResolvedValueOnce([{ name: 'ada', displayName: 'Ada Server' }])
      .mockResolvedValueOnce({
        transitions: [{ id: '31', name: 'Done', to: { id: '5', name: 'Done' } }]
      })

    const {
      listAssignableUsers,
      listCreateFields,
      listIssueTypes,
      listPriorities,
      listProjects,
      listTransitions
    } = await import('./issues')

    await expect(listProjects('server-1')).resolves.toEqual([
      {
        id: '10000',
        key: 'SRV',
        name: 'Server Project',
        siteId: 'server-1',
        siteName: 'Example Jira Server'
      }
    ])
    await expect(listIssueTypes('10000', 'server-1')).resolves.toMatchObject([
      { id: '1', name: 'Task' }
    ])
    await expect(listCreateFields('10000', '1', 'server-1')).resolves.toMatchObject([
      { key: 'customfield_1', name: 'Severity' }
    ])
    await expect(listPriorities('server-1')).resolves.toMatchObject([{ id: '2', name: 'High' }])
    await expect(listAssignableUsers('SRV-1', 'ad', 'server-1')).resolves.toMatchObject([
      { userId: 'ada', accountId: 'ada', displayName: 'Ada Server' }
    ])
    await expect(listTransitions('SRV-1', 'server-1')).resolves.toMatchObject([
      { id: '31', name: 'Done' }
    ])

    expect(jiraRequestMock.mock.calls.map((call) => String(call[1]))).toEqual([
      '/rest/api/2/project',
      '/rest/api/2/issue/createmeta/10000/issuetypes?maxResults=100&startAt=0',
      '/rest/api/2/issue/createmeta/10000/issuetypes/1?maxResults=100&startAt=0',
      '/rest/api/2/priority',
      '/rest/api/2/user/assignable/search?issueKey=SRV-1&maxResults=50&username=ad',
      '/rest/api/2/issue/SRV-1/transitions'
    ])
  })
})
