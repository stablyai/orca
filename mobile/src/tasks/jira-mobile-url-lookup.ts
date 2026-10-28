import type { JiraIssue, JiraSite } from '../../../src/shared/jira/jira-types'
import {
  getMatchingJiraSites,
  isResolvedJiraIssueMatch,
  parseJiraIssueUrl
} from '../../../src/shared/jira/jira-issue-url'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { jiraIssueRead } from './mobile-jira-operations'

// Match a connected site before resolving keys that may exist on several sites.
export async function lookupJiraIssueByUrl(
  client: RpcOperationSender,
  value: string,
  sites: readonly JiraSite[]
): Promise<JiraIssue | null> {
  const parsed = parseJiraIssueUrl(value)
  if (!parsed) {
    return null
  }
  for (const site of getMatchingJiraSites(parsed, sites)) {
    // Another connected account for this origin may have access.
    const issue = await jiraIssueRead
      .request(client, { key: parsed.issueKey, siteId: site.id })
      .then((reply) => jiraIssueRead.interpret(reply))
      .catch(() => null)
    if (issue && isResolvedJiraIssueMatch(parsed, site, issue)) {
      return issue
    }
  }
  return null
}
