import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../src/shared/jira-types'
import type { RpcResponse } from '../transport/types'
import { fetchJiraIssueDetail, fetchJiraTaskIssues } from './mobile-jira-task-source'

const issue: JiraIssue = {
  id: '1',
  key: 'ORCA-7',
  title: 'Read Jira on mobile',
  url: 'https://acme.atlassian.net/browse/ORCA-7',
  siteId: 'site-a',
  description: 'A description',
  labels: ['mobile'],
  project: { id: 'p', key: 'ORCA', name: 'Orca' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  updatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z'
}

describe('mobile Jira task requests', () => {
  it('targets the phone-selected site, caps reads, and salvages malformed list rows', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ id: 'jira-test', ok: true, result: [null, { key: 'bad' }, issue] })
    await expect(
      fetchJiraTaskIssues({ sendRequest }, { jql: '', filter: 'reported', siteId: 'site-b' })
    ).resolves.toEqual([issue])
    expect(sendRequest).toHaveBeenCalledWith('jira.listIssues', {
      filter: 'reported',
      limit: 50,
      siteId: 'site-b'
    })
  })

  it('uses JQL instead of combining it with the named preset', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ id: 'jira-test', ok: true, result: { issues: [issue] } })
    await expect(
      fetchJiraTaskIssues(
        { sendRequest },
        { jql: ' project = ORCA ', filter: 'assigned', siteId: 'all' }
      )
    ).resolves.toEqual([issue])
    expect(sendRequest).toHaveBeenCalledWith('jira.searchIssues', {
      jql: 'project = ORCA',
      limit: 50,
      siteId: 'all'
    })
  })

  it('rejects an incompatible list envelope instead of presenting it as empty', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ id: 'jira-test', ok: true, result: { error: 'bad response' } })
    await expect(
      fetchJiraTaskIssues({ sendRequest }, { jql: '', filter: 'assigned', siteId: null })
    ).rejects.toThrow(/jira.listIssues/)
  })

  it('keeps the issue readable when optional comments refuse, disconnect, or fail validation', async () => {
    const commentReplies: (RpcResponse | null)[] = [
      null,
      { id: 'jira-test', ok: false, error: { code: 'UNAVAILABLE', message: 'Unavailable' } },
      { id: 'jira-test', ok: true, result: 'bad comments' }
    ]
    for (const response of commentReplies) {
      const sendRequest = vi.fn(async (method: string) => {
        if (method === 'jira.getIssue') {
          return { id: 'jira-test', ok: true as const, result: issue }
        }
        if (response === null) {
          throw new Error('Connection lost')
        }
        return response
      })
      await expect(
        fetchJiraIssueDetail({ sendRequest }, { key: issue.key, siteId: issue.siteId })
      ).resolves.toEqual({ issue, comments: [] })
    }
  })

  it('surfaces issue failures even when comments can be read', async () => {
    const sendRequest = vi.fn(async (method: string) =>
      method === 'jira.getIssue'
        ? {
            id: 'jira-test',
            ok: false as const,
            error: { code: 'UNAVAILABLE', message: 'Issue permission denied' }
          }
        : { id: 'jira-test', ok: true as const, result: [] }
    )
    await expect(fetchJiraIssueDetail({ sendRequest }, { key: issue.key })).rejects.toThrow(
      'Issue permission denied'
    )
  })
})
