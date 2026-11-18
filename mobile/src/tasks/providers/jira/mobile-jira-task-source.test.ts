import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../../../src/shared/jira/jira-types'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
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

  it('searches typed text as a key or words, and retries rejected JQL as text, like desktop', async () => {
    const sentJql: string[] = []
    const sendRequest = vi.fn(async (_method: string, params?: unknown) => {
      const jql = params && typeof params === 'object' && 'jql' in params ? String(params.jql) : ''
      sentJql.push(jql)
      if (jql === 'status = Doen') {
        return {
          id: 'jira-test',
          ok: false as const,
          error: { code: 'runtime_error', message: "Error 400: The value 'Doen' does not exist" }
        }
      }
      return { id: 'jira-test', ok: true as const, result: jql.startsWith('text') ? [issue] : [] }
    })
    const search = (query: string) =>
      fetchJiraTaskIssues({ sendRequest }, { query, filter: 'assigned', siteId: null })
    await expect(search('proj-12')).resolves.toEqual({ issues: [issue], jqlRejection: null })
    await expect(search('login bug')).resolves.toEqual({ issues: [issue], jqlRejection: null })
    await expect(search('status = Doen')).resolves.toEqual({
      issues: [issue],
      jqlRejection: { reason: "The value 'Doen' does not exist", likelyTypo: true }
    })
    expect(sentJql).toEqual([
      'key = "PROJ-12"',
      'text ~ "proj 12*"',
      'text ~ "login bug*"',
      'status = Doen',
      'text ~ "status = doen*"'
    ])
  })
})
