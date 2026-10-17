import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const { clearTokenMock, getClientsMock, isAuthErrorMock, jiraRequestMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))

vi.mock('./request-queue', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

function makeEntry(authType?: 'server'): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1',
      ...(authType ? { authType } : {})
    },
    authorization: 'Basic token'
  }
}

const editmeta = {
  fields: {
    summary: {
      name: 'Summary',
      schema: { type: 'string', system: 'summary' },
      operations: ['set']
    },
    description: {
      name: 'Description',
      schema: { type: 'string', system: 'description' },
      operations: ['set']
    },
    components: {
      name: 'Components',
      schema: { type: 'array', items: 'component', system: 'components' },
      operations: ['add', 'set', 'remove'],
      allowedValues: [
        { id: '1', name: 'API' },
        { id: '2', name: 'Legacy', archived: true }
      ]
    },
    duedate: { name: 'Due date', schema: { type: 'date', system: 'duedate' }, operations: ['set'] },
    customfield_10010: {
      name: 'Sprint',
      schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
      operations: ['set']
    },
    customfield_10019: {
      name: 'Rank',
      schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' },
      operations: ['set']
    },
    reporter: { name: 'Reporter', required: true, schema: { type: 'user', system: 'reporter' } }
  }
}

describe('getIssueEditFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
  })

  it('reads editmeta, then only the listed field values', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce(editmeta).mockResolvedValueOnce({
      fields: {
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
        },
        components: [{ id: '1', name: 'API' }],
        duedate: '2026-10-20',
        customfield_10010: [{ id: 7, name: 'Sprint 7', state: 'active' }],
        reporter: { accountId: 'account-9', displayName: 'Ada' }
      }
    })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const fields = await getIssueEditFields('ENG-1', 'site-1', true)

    expect(jiraRequestMock.mock.calls[0][1]).toBe('/rest/api/3/issue/ENG-1/editmeta')
    // Summary has its own control and Rank is not user-editable, so neither is read.
    expect(jiraRequestMock.mock.calls[1][1]).toBe(
      '/rest/api/3/issue/ENG-1?fields=description%2Ccomponents%2Cduedate%2Ccustomfield_10010%2Creporter'
    )
    expect(fields.map((field) => [field.key, field.writable, field.value])).toEqual([
      ['description', true, { kind: 'text', text: 'Hello' }],
      ['components', true, { kind: 'options', options: [{ id: '1', name: 'API' }] }],
      ['duedate', true, { kind: 'text', text: '2026-10-20' }],
      ['customfield_10010', true, { kind: 'unsupported', display: 'Sprint 7' }],
      [
        'reporter',
        false,
        {
          kind: 'users',
          users: [
            { accountId: 'account-9', displayName: 'Ada', avatarUrl: undefined, email: undefined }
          ]
        }
      ]
    ])
    expect(fields[0]).toMatchObject({ richText: true })
    // Archived versions/components stay visible as values but are not offered.
    expect(fields[1].allowedValues).toEqual([{ id: '1', name: 'API' }])
  })

  it('marks Cloud rich text with content Markdown cannot keep as not writable', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { description: editmeta.fields.description } })
      .mockResolvedValueOnce({
        fields: {
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1' } }] }]
          }
        }
      })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const [description] = await getIssueEditFields('ENG-1', 'site-1', true)

    expect(description).toMatchObject({ key: 'description', richText: true, writable: false })
  })

  it('edits Server/DC wiki text verbatim', async () => {
    getClientsMock.mockReturnValue([makeEntry('server')])
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { description: editmeta.fields.description } })
      .mockResolvedValueOnce({ fields: { description: 'h1. Title\n*bold*' } })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const [description] = await getIssueEditFields('ENG-1', 'site-1', true)

    expect(jiraRequestMock.mock.calls[0][1]).toBe('/rest/api/2/issue/ENG-1/editmeta')
    expect(description).toMatchObject({
      writable: true,
      value: { kind: 'text', text: 'h1. Title\n*bold*' }
    })
  })

  it('skips the value read when nothing on the screen is listed', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockResolvedValueOnce({ fields: { summary: editmeta.fields.summary } })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    await expect(getIssueEditFields('ENG-1', 'site-1', true)).resolves.toEqual([])
    expect(jiraRequestMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces failures for strict reads and clears tokens on auth errors', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock.mockRejectedValueOnce(new Error('Error 500'))
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')
    await expect(getIssueEditFields('ENG-1', 'site-1', true)).rejects.toThrow('Error 500')

    const authError = new Error('Error 401')
    isAuthErrorMock.mockImplementation((error) => error === authError)
    jiraRequestMock.mockRejectedValueOnce(authError)
    await expect(getIssueEditFields('ENG-1', 'site-1')).rejects.toBe(authError)
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
  })
})
