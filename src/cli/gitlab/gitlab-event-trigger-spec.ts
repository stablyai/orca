// `--on "gitlab.<event> in=<group/project>,… from=… contains=… host=…"`: a webhook rule the host
// connects to each GitLab project itself (automation-gitlab-triggers.ts).
import type { AutomationWebhookTrigger } from '../../shared/automation-event-triggers'
import {
  GITLAB_EVENT_KINDS,
  gitlabWebhookFilters,
  type GitLabEventKind,
  type GitLabEventRule
} from '../../shared/automation-gitlab-triggers'
import { WEBHOOK_FILTER_LIMITS } from '../../shared/connector-webhook-contract'
import { RuntimeClientError } from '../runtime/connection/types'

type Entry = readonly [key: string, value: string, ...written: string[]]

const KEYS = ['in', 'from', 'contains', 'host'] as const

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function listOf(spec: string, key: string, raw: string | undefined): string[] | undefined {
  const list = raw
    ?.split(',')
    .map((entry) => entry.trim().replace(/^@/, ''))
    .filter(Boolean)
  if (list && list.length > WEBHOOK_FILTER_LIMITS.maxValues) {
    throw invalid(
      `--on "${spec}" takes at most ${WEBHOOK_FILTER_LIMITS.maxValues} values for ${key}=.`
    )
  }
  return list?.length ? [...new Set(list)].sort() : undefined
}

export function parseGitLabTrigger(
  spec: string,
  head: string,
  entries: readonly Entry[]
): AutomationWebhookTrigger {
  const event = GITLAB_EVENT_KINDS.find((kind) => `gitlab.${kind}` === head)
  if (!event) {
    throw invalid(
      `Unknown event "${head}". GitLab has ${GITLAB_EVENT_KINDS.map((kind) => `gitlab.${kind}`).join(', ')}.`
    )
  }
  const values = new Map<(typeof KEYS)[number], string>()
  for (const [key, value] of entries) {
    const known = KEYS.find((entry) => entry === key)
    if (!known) {
      throw invalid(
        `Unknown filter "${key}=" in --on "${spec}". Use in=, from=, contains= or host=.`
      )
    }
    if (values.has(known) || !value.trim()) {
      throw invalid(`--on "${spec}" needs one value for ${known}=.`)
    }
    values.set(known, value.trim())
  }
  const projects = listOf(spec, 'in', values.get('in'))
  // GitLab has no "everywhere the bot is": the host adds a webhook to each project named.
  if (!projects || projects.some((project) => !project.includes('/'))) {
    throw invalid(
      `--on "${spec}" needs in= to name GitLab projects as group/project, separated by commas.`
    )
  }
  const contains = values.get('contains')
  if (contains !== undefined && event !== 'comment') {
    throw invalid(`--on "${spec}": contains= is for gitlab.comment only.`)
  }
  const host = values
    .get('host')
    ?.replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
  if (host !== undefined && (!host || host.includes('/'))) {
    throw invalid(`--on "${spec}": host= takes a GitLab host such as gitlab.example.com.`)
  }
  const from = listOf(spec, 'from', values.get('from'))
  const rule: GitLabEventRule = Object.assign(
    { event, projects },
    host ? { host } : {},
    from ? { from } : {},
    contains ? { contains } : {}
  )
  return { id: '', source: 'webhook', event: 'call', rev: 0, ...gitlabWebhookFilters(rule) }
}

function quoteValue(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value
}

/** The rule as an --on value; parsing it gives the same filters back. */
export function formatGitLabTrigger(rule: GitLabEventRule): string {
  return [
    `gitlab.${rule.event}`,
    `in=${rule.projects.join(',')}`,
    ...(rule.from?.length ? [`from=${rule.from.join(',')}`] : []),
    ...(rule.contains ? [`contains=${quoteValue(rule.contains)}`] : []),
    ...(rule.host ? [`host=${rule.host}`] : [])
  ].join(' ')
}

const EVENT_WORDS: Record<GitLabEventKind, string> = {
  comment: 'someone comments on an issue or merge request',
  issue_opened: 'an issue is opened',
  mr_opened: 'a merge request is opened',
  mr_merged: 'a merge request is merged',
  pipeline_failed: 'a pipeline fails'
}

/** "on GitLab, someone comments on an issue or merge request, in acme/web, containing "@scout"". */
export function describeGitLabTrigger(rule: GitLabEventRule): string {
  return [
    `on GitLab, ${EVENT_WORDS[rule.event]}`,
    `in ${rule.projects.join(', ')}${rule.host ? ` on ${rule.host}` : ''}`,
    ...(rule.contains ? [`containing "${rule.contains}"`] : []),
    ...(rule.from?.length ? [`from ${rule.from.join(', ')}`] : [])
  ].join(', ')
}

export const GITLAB_TRIGGER_OPTIONS = [
  "gitlab: through the automation's own webhook. Orca adds a signed webhook to each project in= names, with the glab sign-in on the bot's computer, which needs the Maintainer role there.",
  ...GITLAB_EVENT_KINDS.map((event) => `  gitlab.${event}  when ${EVENT_WORDS[event]}`),
  '  in=<group/project>,…  the GitLab projects to listen in; needed, up to 10',
  '  from=<people>  only these GitLab usernames, comma-separated; anyone by default',
  '  contains="<text>"  gitlab.comment only: only comments containing this (any case); contains="@<name>" listens for a mention',
  "  host=<host>  a self-managed GitLab such as gitlab.example.com; glab's default host otherwise",
  '  The run gets the event\'s fields quoted. Answer on GitLab with glab: `glab issue note <iid> -R <project> -m "…"` or `glab mr note <iid> -R <project> -m "…"`. A reply posted with glab comes from your GitLab account, so never put the contains= text in it, or it starts the automation again.'
].join('\n')
