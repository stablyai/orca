import type { JiraIssue, JiraSiteSelection } from '../../../src/shared/jira-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { extractJiraIssueReadItems, toJiraDetailComments } from './jira-mobile-issue-read'

export const JIRA_TASK_LIMIT = 50

const DETAIL_TIMEOUT_MS = 30_000

// A typed JQL query replaces the preset entirely, matching desktop: the Tasks
// search box is a raw JQL field, not free text.
export async function fetchJiraTaskIssues(
  client: RpcClient,
  args: { jql: string; filter: string; siteId: JiraSiteSelection | null }
): Promise<JiraIssue[]> {
  const jql = args.jql.trim()
  const response = jql
    ? await client.sendRequest('jira.searchIssues', {
        jql,
        limit: JIRA_TASK_LIMIT,
        siteId: args.siteId ?? undefined
      })
    : await client.sendRequest('jira.listIssues', {
        filter: args.filter,
        limit: JIRA_TASK_LIMIT,
        siteId: args.siteId ?? undefined
      })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return [...extractJiraIssueReadItems((response as RpcSuccess).result)].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  )
}

export async function fetchJiraIssueDetail(
  client: RpcClient,
  args: { key: string; siteId?: string }
): Promise<{ issue: JiraIssue; comments: ReturnType<typeof toJiraDetailComments> }> {
  const params = { key: args.key, siteId: args.siteId }
  const [issueResponse, commentsResponse] = await Promise.all([
    client.sendRequest('jira.getIssue', params, { timeoutMs: DETAIL_TIMEOUT_MS }),
    client.sendRequest('jira.issueComments', params, { timeoutMs: DETAIL_TIMEOUT_MS })
  ])
  if (!issueResponse.ok) {
    throw new Error(issueResponse.error.message)
  }
  const issue = (issueResponse as RpcSuccess).result as JiraIssue | null
  if (!issue) {
    throw new Error('Details not found')
  }
  // Comments are best-effort: a failed fetch still renders the issue body.
  return {
    issue,
    comments: commentsResponse.ok
      ? toJiraDetailComments((commentsResponse as RpcSuccess).result)
      : []
  }
}
