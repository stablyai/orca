import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  jiraRequestBinaryMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  jiraRequestBinaryMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args),
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args),
  jiraRequestBinary: (...args: unknown[]) => jiraRequestBinaryMock(...args),
  JiraApiError: class JiraApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  }
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
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

describe('Jira ADF link mark mapping', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([makeEntry()])
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockImplementation(() => {})
    jiraRequestBinaryMock.mockReset()
    jiraRequestMock.mockReset()
    const { _resetAttachmentImageCache } = await import('./attachment-image-cache')
    _resetAttachmentImageCache()
  })

  it('maps ADF link marks in descriptions to Markdown hyperlinks', async () => {
    const { mapJiraIssue } = await import('./issues')

    const issue = mapJiraIssue(makeEntry().site, {
      id: 'issue-link-1',
      key: 'PM-1',
      fields: {
        summary: 'Linked description',
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                {
                  type: 'text',
                  text: 'Design spec',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]
                },
                { type: 'text', text: '.' }
              ]
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

    expect(issue.description).toBe('See [Design spec](https://example.com/spec).')
  })

  it('leaves Server/DC plain-text descriptions unchanged', async () => {
    const { mapJiraIssue } = await import('./issues')

    const issue = mapJiraIssue(makeServerEntry().site, {
      id: 'issue-server-1',
      key: 'SRV-1',
      fields: {
        summary: 'Server body',
        description: 'Plain body with https://example.com raw URL',
        project: { id: '1', key: 'SRV', name: 'Server' },
        issuetype: { id: '1', name: 'Bug' },
        status: {
          id: '1',
          name: 'Open',
          statusCategory: { key: 'new', name: 'To Do' }
        },
        labels: [],
        created: '2026-06-18T00:00:00.000Z',
        updated: '2026-06-18T00:00:00.000Z'
      }
    })

    expect(issue.description).toBe('Plain body with https://example.com raw URL')
  })

  it('maps ADF link marks in comments to Markdown hyperlinks', async () => {
    jiraRequestMock.mockResolvedValueOnce({
      comments: [
        {
          id: 'comment-link-1',
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Follow-up',
                    marks: [{ type: 'link', attrs: { href: 'https://example.com/follow-up' } }]
                  }
                ]
              }
            ]
          },
          created: '2026-05-30T12:00:00.000Z',
          author: { accountId: 'user-1', displayName: 'Ada' }
        }
      ]
    })

    const { getIssueComments } = await import('./issues')
    const comments = await getIssueComments('ALP-1', 'site-1')

    expect(jiraRequestMock).toHaveBeenCalledTimes(1)
    expect(jiraRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: expect.objectContaining({ id: 'site-1' }) }),
      expect.stringContaining('/issue/ALP-1/comment?')
    )
    expect(comments[0]?.body).toBe('[Follow-up](https://example.com/follow-up)')
  })

  it('keeps media markdown when links and images share a description', async () => {
    const resolveMedia = () => '![shot.png](data:image/png;base64,abc)'
    const { adfToMarkdownText } = await import('./adf-markdown')
    const markdown = adfToMarkdownText(
      {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Design spec',
                marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]
              }
            ]
          },
          {
            type: 'mediaSingle',
            content: [
              {
                type: 'media',
                attrs: { id: 'media-1', type: 'file', alt: 'shot.png' }
              }
            ]
          }
        ]
      },
      { resolveMedia }
    )

    expect(markdown).toBe(
      '[Design spec](https://example.com/spec)\n\n![shot.png](data:image/png;base64,abc)'
    )
  })
})
