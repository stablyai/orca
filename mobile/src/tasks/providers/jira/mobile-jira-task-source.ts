import type {
  JiraIssue,
  JiraIssueFilter,
  JiraSiteSelection
} from '../../../../../src/shared/jira/jira-types'
import {
  searchJiraIssuesByInput,
  type JiraInputSearchResult
} from '../../../../../src/shared/jira/jira-issue-input-search'
import type { UnvalidatedRpcRequestPort } from '../../../transport/rpc/unvalidated-rpc-request-port'
import { toJiraDetailComments } from './jira-mobile-issue-read'
import {
  jiraIssueCommentsRead,
  jiraIssueListRead,
  jiraIssueRead,
  jiraIssueSearchRead
} from './mobile-jira-operations'

export const JIRA_TASK_LIMIT = 50

const DETAIL_TIMEOUT_MS = 30_000

// A search replaces the selected preset, matching desktop.
export async function fetchJiraTaskIssues(
  client: UnvalidatedRpcRequestPort,
  args: { query: string; filter: JiraIssueFilter; siteId: JiraSiteSelection | null }
): Promise<JiraInputSearchResult> {
  const query = args.query.trim()
  const { issues, jqlRejection } = query
    ? await searchJiraIssuesByInput(query, async (jql) => [
        ...jiraIssueSearchRead.interpret(
          await jiraIssueSearchRead.request(client, {
            jql,
            limit: JIRA_TASK_LIMIT,
            siteId: args.siteId ?? undefined
          })
        )
      ])
    : {
        issues: jiraIssueListRead.interpret(
          await jiraIssueListRead.request(client, {
            filter: args.filter,
            limit: JIRA_TASK_LIMIT,
            siteId: args.siteId ?? undefined
          })
        ),
        jqlRejection: null
      }
  return {
    issues: [...issues].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    jqlRejection
  }
}

export async function fetchJiraIssueDetail(
  client: UnvalidatedRpcRequestPort,
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
