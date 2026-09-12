import {
  getMatchingJiraSites,
  JIRA_ISSUE_KEY_PATTERN,
  parseJiraIssueUrl,
  type ParsedJiraIssueUrl
} from '../../shared/jira-issue-url'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import type { WorkspaceLinkedItem } from '../../shared/types'
import type { JiraIssue, JiraSite } from '../../shared/jira-types'

export type JiraIssueLinkInput =
  | { clear: true }
  | { clear: false; issueKey: string; parsed: ParsedJiraIssueUrl | null }

/**
 * Parses `--jira`, accepting a bare issue key (`PROJ-123`) or a full Jira issue
 * URL. `null` clears the link.
 *
 * The URL form also carries the site origin, which matters when more than one
 * Jira site is connected: the same key can exist on two instances, so a bare
 * key resolves against the active site while a URL pins the one it came from.
 */
export function getOptionalJiraIssueLinkFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowNull?: boolean } = {}
): JiraIssueLinkInput | undefined {
  const value = getPresentStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed.toLowerCase() === 'null') {
    if (!options.allowNull) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Omit --jira on create, or pass a Jira issue key or URL.'
      )
    }
    return { clear: true }
  }

  const parsed = parseJiraIssueUrl(trimmed)
  if (parsed) {
    return { clear: false, issueKey: parsed.issueKey, parsed }
  }

  if (JIRA_ISSUE_KEY_PATTERN.test(trimmed)) {
    return { clear: false, issueKey: trimmed.toUpperCase(), parsed: null }
  }

  throw new RuntimeClientError(
    'invalid_argument',
    'Pass a Jira issue key like PROJ-123, a Jira issue URL, or null to clear.'
  )
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

/**
 * Turns `--jira` into the `linkedWorkItem` the workspace stores.
 *
 * The title and URL are not something the caller should have to type, so the
 * key is resolved against the connected Jira site. Failing to resolve is a hard
 * error rather than a partial link: a card showing a key with no title or URL
 * is worse than no link at all, and the card renderer already expects both.
 */
export async function resolveJiraWorkItem(
  input: ReturnType<typeof getOptionalJiraIssueLinkFlag>,
  client: RuntimeClient
): Promise<{ linkedWorkItem?: WorkspaceLinkedItem | null }> {
  if (input === undefined) {
    return {}
  }
  if (input.clear) {
    return { linkedWorkItem: null }
  }

  const status = await client.call<{
    connected: boolean
    sites: JiraSite[]
    activeSiteId: string | null
  }>('jira.status', null)
  const all = status.result?.sites ?? []
  // A URL pins its own site; a bare key uses the active one. Matching goes
  // through the shared helper rather than a prefix test: origin has to be equal,
  // not a prefix (a look-alike host would pass), and Jira Server instances can
  // share a host while differing only in their path.
  const site = input.parsed
    ? getMatchingJiraSites(input.parsed, all)[0]
    : resolveActiveJiraSite(all, status.result?.activeSiteId ?? null)
  if (!site) {
    throw new RuntimeClientError(
      'invalid_argument',
      input.parsed
        ? `No connected Jira site matches ${input.parsed.origin}. Connect it first, or pass a bare issue key to use the active site.`
        : 'No Jira site is connected. Connect one in Settings before linking an issue.'
    )
  }

  // The handler returns the issue itself, not a wrapper object.
  const looked = await client.call<JiraIssue | null>('jira.lookupIssueSummary', {
    key: input.issueKey,
    siteId: site.id
  })
  const issue = looked.result
  if (!issue) {
    throw new RuntimeClientError('invalid_argument', `Jira issue ${input.issueKey} was not found.`)
  }

  return {
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      // Why: Jira keys are not numeric, so the shared numeric field carries no
      // meaning here; the identifier is what the card renders.
      number: 0,
      title: issue.title,
      url: issue.url,
      jiraIdentifier: issue.key
    }
  }
}

/**
 * Picks the site a bare issue key resolves against.
 *
 * Falling back to the first site is only safe when it is the only one: with
 * several connected, the same key can exist on more than one, and silently
 * guessing would link the wrong ticket.
 */
function resolveActiveJiraSite(
  sites: readonly JiraSite[],
  activeSiteId: string | null
): JiraSite | undefined {
  const active = sites.find((candidate) => candidate.id === activeSiteId)
  if (active) {
    return active
  }
  if (sites.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Several Jira sites are connected and none is active. Pass a full Jira issue URL so the site is unambiguous.'
    )
  }
  return sites[0]
}
