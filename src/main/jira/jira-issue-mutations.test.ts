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
  apiBasePath: () => '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

// A Jira Cloud site: no authType, so bodies go out as ADF.
const cloudEntry: JiraClientForSite = {
  site: {
    id: 'site-1',
    siteUrl: 'https://example.atlassian.net',
    email: 'ada@example.com',
    displayName: 'Example Jira',
    accountId: 'account-1'
  },
  authorization: 'Basic token'
}

function sentBody(init: unknown): unknown {
  return init && typeof init === 'object' && 'body' in init && typeof init.body === 'string'
    ? JSON.parse(init.body)
    : undefined
}

const lineBreakDoc = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'hardBreak' },
        { type: 'text', text: 'line two' }
      ]
    }
  ]
}

describe('Jira body text', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([cloudEntry])
  })

  it('sends Cloud comments as ADF that keeps single newlines as line breaks', async () => {
    jiraRequestMock.mockResolvedValueOnce({ id: 'c1' })
    const { addIssueComment } = await import('./jira-issue-mutations')

    await addIssueComment('ENG-1', 'first\nsecond\n\n**third**', 'site-1')

    const [, path, init] = jiraRequestMock.mock.calls[0]
    expect(path).toBe('/rest/api/3/issue/ENG-1/comment')
    expect(sentBody(init)).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'first' },
              { type: 'hardBreak' },
              { type: 'text', text: 'second' }
            ]
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'third', marks: [{ type: 'strong' }] }]
          }
        ]
      }
    })
  })

  it('builds Cloud transition comments and new-issue descriptions the same way', async () => {
    jiraRequestMock.mockResolvedValue({ id: '10', key: 'ENG-2', self: '' })
    const { createIssue, updateIssue } = await import('./jira-issue-mutations')

    await createIssue({
      siteId: 'site-1',
      projectId: 'p1',
      issueTypeId: 't1',
      title: 'New issue',
      description: 'line one\nline two'
    })
    await updateIssue(
      'ENG-1',
      { transitionId: '31', transitionComment: 'line one\nline two' },
      'site-1'
    )

    expect(sentBody(jiraRequestMock.mock.calls[0][2])).toHaveProperty(
      'fields.description',
      lineBreakDoc
    )
    const [, transitionPath, transitionInit] = jiraRequestMock.mock.calls[1]
    expect(transitionPath).toBe('/rest/api/3/issue/ENG-1/transitions')
    expect(sentBody(transitionInit)).toHaveProperty('update.comment', [
      { add: { body: lineBreakDoc } }
    ])
  })
})
