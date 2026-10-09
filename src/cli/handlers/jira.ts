import type { JiraComment, JiraConnectionStatus, JiraIssue } from '../../shared/jira-types'
import {
  getMatchingJiraSites,
  JIRA_ISSUE_KEY_PATTERN,
  parseJiraIssueUrl
} from '../../shared/jira-issue-url'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

async function resolveIssueTarget({ flags, client }: HandlerContext) {
  const input = getRequiredStringFlag(flags, 'id').trim()
  const siteId = getOptionalStringFlag(flags, 'site')
  const parsed = parseJiraIssueUrl(input)
  if (!parsed && !JIRA_ISSUE_KEY_PATTERN.test(input)) {
    throw new RuntimeClientError('invalid_argument', 'Expected a Jira issue key or browse URL.')
  }
  const { result: status } = await client.call<JiraConnectionStatus>('jira.status')
  const sites = status.sites ?? []
  const matching = parsed ? getMatchingJiraSites(parsed, sites) : sites
  const candidates = siteId ? matching.filter((site) => site.id === siteId) : matching
  if (candidates.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      candidates.length === 0
        ? 'No matching connected Jira site. Check orca jira status and Orca Jira settings.'
        : 'Multiple Jira sites match. Select one with --site using orca jira status.'
    )
  }
  return { key: parsed?.issueKey ?? input.toUpperCase(), siteId: candidates[0].id }
}

export const JIRA_HANDLERS: Record<string, CommandHandler> = {
  'jira status': async ({ client, json }) => {
    const response = await client.call<JiraConnectionStatus>('jira.status')
    printResult(response, json, (status) => {
      const sites = (status.sites ?? []).map((site) => `${site.id}\t${site.siteUrl}`)
      return [
        ...sites,
        ...(status.credentialError ? [status.credentialError] : []),
        'Saved Orca Jira connections; this does not verify access or agent MCP authentication.'
      ].join('\n')
    })
  },
  'jira issue': async (context) => {
    const target = await resolveIssueTarget(context)
    const response = await context.client.call<JiraIssue | null>('jira.getIssue', target)
    if (!response.result) {
      throw new RuntimeClientError(
        'jira_issue_unavailable',
        'Jira issue was not returned. Check the key and site access.'
      )
    }
    printResult(response, context.json, (issue) =>
      issue ? `${issue.key}: ${issue.title}\n${issue.url}\n\n${issue.description ?? ''}` : ''
    )
  },
  'jira comments': async (context) => {
    const target = await resolveIssueTarget(context)
    const response = await context.client.call<JiraComment[]>('jira.issueComments', target)
    // Older runtimes also return [] for failed reads, so absence is not verified.
    if (response.result.length === 0) {
      throw new RuntimeClientError(
        'jira_comments_unverified',
        'No comments returned. This runtime cannot distinguish an empty issue from a failed comment read. Verify in Jira.'
      )
    }
    printResult(response, context.json, (comments) =>
      comments
        .map(
          (comment) =>
            `${comment.id} | ${comment.user?.displayName ?? ''} | ${comment.createdAt}\n${comment.body}`
        )
        .join('\n\n')
    )
  }
}
