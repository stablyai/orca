import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraSite } from '../../shared/jira/jira-types'
import { addIssueComment, createIssue, updateIssue } from './jira-issue-mutations'
import { adfToMarkdownText } from './adf-markdown'

const { request, clients } = vi.hoisted(() => ({ request: vi.fn(), clients: vi.fn() }))
vi.mock('./client', () => ({ getClients: clients, clearToken: vi.fn(), isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: JiraSite) => (site.authType === 'server' ? '/rest/api/2' : '/rest/api/3'),
  jiraRequest: request
}))
const site: JiraSite = {
  id: 'jira',
  siteUrl: 'https://example.atlassian.net',
  email: '',
  displayName: 'Jira',
  accountId: 'ada',
  authType: 'cloud'
}
const body = 'first\nsecond\n\n**third**'
const expectedAdf = {
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
    { type: 'paragraph', content: [{ type: 'text', text: 'third', marks: [{ type: 'strong' }] }] }
  ]
}

beforeEach(() => {
  clients.mockReturnValue([{ site, authorization: 'fixture' }])
  request.mockReset().mockResolvedValue({ id: '123', key: 'EX-1' })
})

async function writeAllBodies(): Promise<unknown[]> {
  await createIssue({ title: 'Example', projectId: '10', issueTypeId: '20', description: body })
  await updateIssue('EX-1', { transitionId: '30', transitionComment: body })
  await addIssueComment('EX-1', body)
  return request.mock.calls.map(([_client, _path, options]) => JSON.parse(options.body))
}

describe('Jira document publication', () => {
  it('stores Markdown and tight line breaks through every Cloud write entry point', async () => {
    expect(await writeAllBodies()).toEqual([
      {
        fields: {
          project: { id: '10' },
          issuetype: { id: '20' },
          summary: 'Example',
          description: expectedAdf
        }
      },
      { transition: { id: '30' }, update: { comment: [{ add: { body: expectedAdf } }] } },
      { body: expectedAdf }
    ])
    expect(adfToMarkdownText(expectedAdf)).toBe('first\\\nsecond\n\n**third**')
  })

  it('keeps Server/DC wiki strings unchanged through the same writes', async () => {
    clients.mockReturnValue([{ site: { ...site, authType: 'server' }, authorization: 'fixture' }])
    expect(await writeAllBodies()).toEqual([
      {
        fields: {
          project: { id: '10' },
          issuetype: { id: '20' },
          summary: 'Example',
          description: body
        }
      },
      { transition: { id: '30' }, update: { comment: [{ add: { body } }] } },
      { body }
    ])
  })
})
