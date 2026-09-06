import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../src/shared/jira-types'
import type { RpcClient } from '../transport/rpc-client'
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

function clientReturning(result: unknown, sendRequest = vi.fn()): RpcClient {
  sendRequest.mockResolvedValue({ ok: true, result })
  return { sendRequest } as unknown as RpcClient
}

describe('lookupJiraIssueByUrl', () => {
  it('resolves an issue through the matching connected site', async () => {
    const sendRequest = vi.fn()
    const client = clientReturning(issue(), sendRequest)
    await expect(
      lookupJiraIssueByUrl(client, 'https://acme.atlassian.net/browse/ORCA-123', [acme, other])
    ).resolves.toMatchObject({ key: 'ORCA-123' })
    expect(sendRequest).toHaveBeenCalledWith('jira.getIssue', {
      key: 'ORCA-123',
      siteId: 'site-acme'
    })
  })

  it('never queries a site the pasted URL does not belong to', async () => {
    const sendRequest = vi.fn()
    const client = clientReturning(issue(), sendRequest)
    // The user is connected to `other` only; a link to acme must not be answered
    // with `other`'s same-keyed issue.
    await expect(
      lookupJiraIssueByUrl(client, 'https://acme.atlassian.net/browse/ORCA-123', [other])
    ).resolves.toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('rejects a response whose issue does not canonically match the link', async () => {
    const client = clientReturning(
      issue({ url: 'https://other.atlassian.net/browse/ORCA-123', siteId: 'site-acme' })
    )
    await expect(
      lookupJiraIssueByUrl(client, 'https://acme.atlassian.net/browse/ORCA-123', [acme])
    ).resolves.toBeNull()
  })

  it('ignores non-Jira and non-browse URLs without a round trip', async () => {
    const sendRequest = vi.fn()
    const client = clientReturning(issue(), sendRequest)
    for (const value of [
      'not a url',
      'https://acme.atlassian.net/jira/software/ORCA-1',
      'ORCA-1'
    ]) {
      await expect(lookupJiraIssueByUrl(client, value, [acme])).resolves.toBeNull()
    }
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('tries the next matching site when one errors', async () => {
    const twin: JiraSite = { ...acme, id: 'site-acme-2' }
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { message: 'boom' } })
      .mockResolvedValueOnce({ ok: true, result: issue({ siteId: 'site-acme-2' }) })
    const client = { sendRequest } as unknown as RpcClient
    await expect(
      lookupJiraIssueByUrl(client, 'https://acme.atlassian.net/browse/ORCA-123', [acme, twin])
    ).resolves.toMatchObject({ siteId: 'site-acme-2' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
