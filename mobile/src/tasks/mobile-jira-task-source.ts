import type { JiraIssue, JiraIssueFilter, JiraSiteSelection } from '../../../src/shared/jira-types'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { toJiraDetailComments } from './jira-mobile-issue-read'
import {
  jiraIssueCommentsRead,
  jiraIssueListRead,
  jiraIssueRead,
  jiraIssueSearchRead
} from './mobile-jira-operations'

export const JIRA_TASK_LIMIT = 50

const DETAIL_TIMEOUT_MS = 30_000

// Raw JQL replaces the selected preset, matching desktop.
export async function fetchJiraTaskIssues(
  client: RpcOperationSender,
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
  client: RpcOperationSender,
  args: { key: string; siteId?: string }
): Promise<{ issue: JiraIssue; comments: ReturnType<typeof toJiraDetailComments> }> {
  const params = { key: args.key, siteId: args.siteId }
  const [issueReply, commentsReply] = await Promise.all([
    jiraIssueRead.request(client, params, { timeoutMs: DETAIL_TIMEOUT_MS }),
    jiraIssueCommentsRead
      .request(client, params, { timeoutMs: DETAIL_TIMEOUT_MS })
      .catch(() => null)
  ])
  const issue = jiraIssueRead.interpret(issueReply)
  if (!issue) {
    throw new Error('Details not found')
  }
  let comments: ReturnType<typeof toJiraDetailComments> = []
  try {
    if (commentsReply) {
      const decoded = jiraIssueCommentsRead.interpret(commentsReply)
      comments = toJiraDetailComments(decoded.accepted ? decoded.value : [])
    }
  } catch {
    // Optional comments must not hide a readable issue.
  }
  return { issue, comments }
}
