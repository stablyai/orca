import type { JiraConnectionStatus, JiraSite } from '../shared/jira/jira-types'
import type { RuntimeStatus } from '../shared/runtime-types'
import { JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../shared/jira/jira-agent-capability'
import {
  getMatchingJiraSites,
  JIRA_ISSUE_KEY_PATTERN,
  parseJiraIssueUrl
} from '../shared/jira-issue-url'
import type { HandlerContext } from './dispatch'
import { getOptionalStringFlag } from './flags'
import { RuntimeClientError } from './runtime-client'

export function resolveJiraTarget(
  context: HandlerContext,
  input: string,
  options?: { siteFlag?: string }
): Promise<{ site: JiraSite; siteId: string; key: string }>
export function resolveJiraTarget(
  context: HandlerContext
): Promise<{ site: JiraSite; siteId: string }>
export async function resolveJiraTarget(
  context: HandlerContext,
  input?: string,
  options: { siteFlag?: string } = {}
): Promise<{ site: JiraSite; siteId: string; key?: string }> {
  const parsed = input === undefined ? null : parseJiraIssueUrl(input)
  if (input !== undefined && !parsed && !JIRA_ISSUE_KEY_PATTERN.test(input.trim())) {
    throw new RuntimeClientError('invalid_argument', 'Expected a Jira issue key or browse URL.')
  }
  const siteFlag = options.siteFlag ?? 'site'
  const explicit = getOptionalStringFlag(context.flags, siteFlag)?.trim()
  if (explicit === 'all') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Choose one Jira site ID; --${siteFlag} all is unsupported.`
    )
  }
  const runtime = await context.client.call<RuntimeStatus>('status.get')
  if (!runtime.result.capabilities?.includes(JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the execution host to use verified Jira commands.'
    )
  }
  const { result: status } = await context.client.call<JiraConnectionStatus>('jira.status')
  if (status.credentialError) {
    throw new RuntimeClientError('jira_credentials_unavailable', status.credentialError)
  }
  const sites = status.sites ?? []
  const matching = parsed ? getMatchingJiraSites(parsed, sites) : sites
  const selected =
    explicit ?? (!parsed && status.selectedSiteId !== 'all' ? status.selectedSiteId : undefined)
  const candidates = selected ? matching.filter((site) => site.id === selected) : matching
  if (candidates.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      candidates.length === 0
        ? 'No matching connected Jira site. Check orca jira connection and Orca Jira settings.'
        : `Multiple Jira sites match. Select one with --${siteFlag} using orca jira connection.`
    )
  }
  const site = candidates[0]
  return {
    site,
    siteId: site.id,
    ...(input === undefined ? {} : { key: parsed?.issueKey ?? input.trim().toUpperCase() })
  }
}
