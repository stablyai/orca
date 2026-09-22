import type { JiraIssue, JiraSite } from '../../../src/shared/jira-types'
import {
  getMatchingJiraSites,
  isResolvedJiraIssueMatch,
  parseJiraIssueUrl
} from '../../../src/shared/jira-issue-url'
import type { RpcClient } from '../transport/rpc-client'
import { jiraIssueRead } from './mobile-jira-operations'

// Resolves a pasted Jira browse URL to the issue it points at, but only through a
// site the user has actually connected. Matching the site first (rather than
// trusting the pasted origin) keeps a link to a foreign site from being answered
// with a same-keyed issue from the user's own site.
export async function lookupJiraIssueByUrl(
  client: RpcClient,
  value: string,
  sites: readonly JiraSite[]
): Promise<JiraIssue | null> {
  const parsed = parseJiraIssueUrl(value)
  if (!parsed) {
    return null
  }
  for (const site of getMatchingJiraSites(parsed, sites)) {
    // A site that cannot answer is skipped rather than raised: the next connected site may be
    // the one the link belongs to.
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
