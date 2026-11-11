import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../src/shared/jira/jira-types'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import { lookupJiraIssueByUrl } from './jira-mobile-url-lookup'

const acme: JiraSite = {
  id: 'site-acme',
  siteUrl: 'https://acme.atlassian.net',
  email: 'me@acme.com',
  displayName: 'Acme',
  accountId: 'acc-1'
}
const other: JiraSite = { ...acme, id: 'site-other', siteUrl: 'https://other.atlassian.net' }

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '1',
    key: 'ORCA-123',
    siteId: 'site-acme',
    title: 'Add Jira to mobile',
    url: 'https://acme.atlassian.net/browse/ORCA-123',
    project: { id: 'p1', key: 'ORCA', name: 'Orca' },
    issueType: { id: 't1', name: 'Task' },
    status: { id: 's1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function clientReturning(result: unknown, sendRequest = vi.fn()): UnvalidatedRpcRequestPort {
  sendRequest.mockResolvedValue({ ok: true, result })
  return { sendRequest }
}

describe('lookupJiraIssueByUrl', () => {
  it('never queries a site the pasted URL does not belong to', async () => {
    const sendRequest = vi.fn()
    const client = clientReturning(issue(), sendRequest)
    // Same issue keys can exist on multiple sites; never answer an acme link with another site’s issue.
    await expect(
      lookupJiraIssueByUrl(client, 'https://acme.atlassian.net/browse/ORCA-123', [other])
    ).resolves.toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
