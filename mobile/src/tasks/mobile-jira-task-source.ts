import type { JiraIssue, JiraIssueFilter, JiraSiteSelection } from '../../../src/shared/jira-types'
import type { RpcClient } from '../transport/rpc-client'
import { toJiraDetailComments } from './jira-mobile-issue-read'
import { jiraIssueCommentsRead, jiraIssueListRead, jiraIssueRead, jiraIssueSearchRead } from './mobile-jira-operations'

export const JIRA_TASK_LIMIT = 50

const DETAIL_TIMEOUT_MS = 30_000

// A typed JQL query replaces the preset entirely, matching desktop: the Tasks
// search box is a raw JQL field, not free text.
export async function fetchJiraTaskIssues(
  client: RpcClient,
  args: { jql: string; filter: JiraIssueFilter; siteId: JiraSiteSelection | null }
): Promise<JiraIssue[]> {
  const jql = args.jql.trim()
  const issues = jql
    ? jiraIssueSearchRead.interpret(
        await jiraIssueSearchRead.request(client, {
          jql,
          limit: JIRA_TASK_LIMIT,
          siteId: args.siteId ?? undefined
        })
      )
    : jiraIssueListRead.interpret(
        await jiraIssueListRead.request(client, {
          filter: args.filter,
          limit: JIRA_TASK_LIMIT,
          siteId: args.siteId ?? undefined
        })
      )
  return [...issues].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export async function fetchJiraIssueDetail(
  client: RpcClient,
  args: { key: string; siteId?: string }
): Promise<{ issue: JiraIssue; comments: ReturnType<typeof toJiraDetailComments> }> {
  const params = { key: args.key, siteId: args.siteId }
  // Interpreted past the group, as the Linear detail is: this Promise.all rejects on the first
  // leg's transport failure, and reading only after both settled is what lets the issue's error
  // win over the comments'.
  const [issueReply, commentsReply] = await Promise.all([
    jiraIssueRead.request(client, params, { timeoutMs: DETAIL_TIMEOUT_MS }),
    jiraIssueCommentsRead.request(client, params, { timeoutMs: DETAIL_TIMEOUT_MS })
  ])
  const issue = jiraIssueRead.interpret(issueReply)
  if (!issue) {
    throw new Error('Details not found')
  }
  // Comments are best-effort: a failed fetch still renders the issue body.
  const comments = jiraIssueCommentsRead.interpret(commentsReply)
  return { issue, comments: toJiraDetailComments(comments.accepted ? comments.value : []) }
}
