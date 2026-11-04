import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AdfRoundTripModule from './adf-round-trip'
import type { JiraClientForSite } from './authenticated-request'

const { adfRoundTripMock, clearTokenMock, getClientsMock, isAuthErrorMock, jiraRequestMock } =
  vi.hoisted(() => ({
    adfRoundTripMock: vi.fn(),
    clearTokenMock: vi.fn(),
    getClientsMock: vi.fn(),
    isAuthErrorMock: vi.fn(),
    jiraRequestMock: vi.fn()
  }))

// Runs the real round-trip check unless a test makes it fail.
vi.mock('./adf-round-trip', async (importOriginal) => {
  const actual = await importOriginal<typeof AdfRoundTripModule>()
  adfRoundTripMock.mockImplementation(actual.adfRoundTripsThroughMarkdown)
  return { adfRoundTripsThroughMarkdown: (...args: unknown[]) => adfRoundTripMock(...args) }
})

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
      // Jira allows `set`, but Orca has no Sprint editor.
      ['customfield_10010', false, { kind: 'unsupported', display: 'Sprint 7' }],
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
    expect(fields.some((field) => 'rawValue' in field)).toBe(false)
  })

  it('reports read-only for empty values whose schema Orca cannot edit', async () => {
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock
      .mockResolvedValueOnce({
        fields: {
          customfield_10010: editmeta.fields.customfield_10010,
          customfield_10030: {
            name: 'Region',
            schema: { type: 'option-with-child', custom: 'cascadingselect' },
            operations: ['set'],
            allowedValues: [{ id: '1', value: 'EU' }]
          },
          customfield_10040: {
            name: 'Team option',
            schema: { type: 'option', custom: 'select' },
            operations: ['set']
          },
          customfield_10050: {
            name: 'Notes',
            schema: { type: 'string', custom: 'textfield' },
            operations: ['set']
          }
        }
      })
      .mockResolvedValueOnce({ fields: {} })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const fields = await getIssueEditFields('ENG-1', 'site-1', true)

    // A select with no offered options has nothing to pick from either.
    expect(fields.map((field) => [field.key, field.value.kind, field.writable])).toEqual([
      ['customfield_10010', 'empty', false],
      ['customfield_10030', 'empty', false],
      ['customfield_10040', 'empty', false],
      ['customfield_10050', 'empty', true]
    ])
  })

  it('adds Jira raw values on request, null when the issue has none', async () => {
    const description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
    }
    const sprint = [{ id: 7, name: 'Sprint 7', state: 'active', boardId: 3 }]
    getClientsMock.mockReturnValue([makeEntry()])
    jiraRequestMock
      .mockResolvedValueOnce(editmeta)
      .mockResolvedValueOnce({ fields: { description, customfield_10010: sprint } })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const fields = await getIssueEditFields('ENG-1', 'site-1', true, true)

    expect(fields.map((field) => [field.key, field.rawValue])).toEqual([
      ['description', description],
      ['components', null],
      ['duedate', null],
      ['customfield_10010', sprint],
      ['reporter', null]
    ])
    // The normalized value stays alongside the raw one.
    expect(fields[0].value).toEqual({ kind: 'text', text: 'Hello' })
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

  it('keeps the field list when one rich-text check fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getClientsMock.mockReturnValue([makeEntry()])
      adfRoundTripMock.mockRejectedValueOnce(new Error('parser failed'))
      jiraRequestMock
        .mockResolvedValueOnce({
          fields: { description: editmeta.fields.description, duedate: editmeta.fields.duedate }
        })
        .mockResolvedValueOnce({
          fields: {
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
            },
            duedate: '2026-10-20'
          }
        })
      const { getIssueEditFields } = await import('./jira-issue-edit-fields')

      const fields = await getIssueEditFields('ENG-1', 'site-1', true)

      // The failed field turns read-only instead of rejecting every field.
      expect(fields.map((field) => [field.key, field.writable])).toEqual([
        ['description', false],
        ['duedate', true]
      ])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
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

  it('keeps Server/DC raw values as wiki text', async () => {
    getClientsMock.mockReturnValue([makeEntry('server')])
    jiraRequestMock
      .mockResolvedValueOnce({ fields: { description: editmeta.fields.description } })
      .mockResolvedValueOnce({ fields: { description: 'h1. Title' } })
    const { getIssueEditFields } = await import('./jira-issue-edit-fields')

    const [description] = await getIssueEditFields('ENG-1', 'site-1', true, true)

    expect(description.rawValue).toBe('h1. Title')
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
