import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget
} from '../../shared/github/comment-types'
import { ghExecFileAsync } from './gh-utils'
import type { GitHubApiRepository, GitHubRepoExecOptions } from './github-api-repository'
import { githubHostExecOptions } from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const MAX_ISSUE_TIMELINE_ITEMS = 300
const GITHUB_REST_PAGE_SIZE = 100

type RestTimelineUser = {
  login?: string | null
  avatar_url?: string | null
}

type RestTimelineIssue = {
  number?: number | null
  title?: string | null
  html_url?: string | null
  repository?: {
    name?: string | null
    owner?: { login?: string | null } | null
  } | null
  pull_request?: unknown
}

type RestTimelineEvent = {
  id?: number | string | null
  node_id?: string | null
  event?: string | null
  actor?: RestTimelineUser | null
  user?: RestTimelineUser | null
  assignee?: RestTimelineUser | null
  created_at?: string | null
  source?: { issue?: RestTimelineIssue | null } | null
  closer?: RestTimelineIssue | null
  state_reason?: string | null
  project_card?: {
    column_name?: string | null
    previous_column_name?: string | null
    project_url?: string | null
  } | null
  project?: { name?: string | null } | null
  project_column_name?: string | null
  previous_column_name?: string | null
}

function isSupportedTimelineEvent(
  eventName: string | null | undefined
): eventName is GitHubIssueTimelineItem['event'] {
  return (
    eventName === 'assigned' ||
    eventName === 'unassigned' ||
    eventName === 'mentioned' ||
    eventName === 'cross-referenced' ||
    eventName === 'closed' ||
    eventName === 'reopened' ||
    eventName === 'moved_columns_in_project'
  )
}

function mapTimelineTarget(
  issue: RestTimelineIssue | null | undefined
): GitHubIssueTimelineTarget | undefined {
  if (!issue || typeof issue.number !== 'number' || !issue.html_url) {
    return undefined
  }
  const owner = issue.repository?.owner?.login
  const repo = issue.repository?.name
  return {
    type: issue.pull_request ? 'pr' : 'issue',
    number: issue.number,
    title: issue.title ?? '',
    url: issue.html_url,
    repository: owner && repo ? `${owner}/${repo}` : undefined
  }
}

function getTimelineActor(event: RestTimelineEvent): { login: string; avatarUrl: string } {
  const actor = event.actor ?? event.user
  return {
    login: actor?.login ?? 'ghost',
    avatarUrl: actor?.avatar_url ?? ''
  }
}

function mapRestTimelineEvent(event: RestTimelineEvent): GitHubIssueTimelineItem | null {
  const eventName = event.event
  if (!isSupportedTimelineEvent(eventName) || !event.created_at) {
    return null
  }
  const actor = getTimelineActor(event)
  const id = String(event.node_id ?? event.id ?? `${eventName}:${event.created_at}`)
  const base = {
    id,
    event: eventName,
    actor: actor.login,
    actorAvatarUrl: actor.avatarUrl,
    createdAt: event.created_at
  }
  if (eventName === 'assigned' || eventName === 'unassigned') {
    return { ...base, assignee: event.assignee?.login ?? undefined }
  }
  if (eventName === 'mentioned' || eventName === 'cross-referenced') {
    return { ...base, source: mapTimelineTarget(event.source?.issue) }
  }
  if (eventName === 'closed') {
    return {
      ...base,
      stateReason: event.state_reason ?? null,
      closer: mapTimelineTarget(event.closer ?? event.source?.issue)
    }
  }
  if (eventName === 'moved_columns_in_project') {
    return {
      ...base,
      previousColumnName:
        event.previous_column_name ?? event.project_card?.previous_column_name ?? null,
      columnName: event.project_column_name ?? event.project_card?.column_name ?? null,
      projectName: event.project?.name ?? null
    }
  }
  return base
}

function parseRestTimelineEventLines(stdout: string): RestTimelineEvent[] {
  const events: RestTimelineEvent[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed)
      }
    } catch {
      // Timeline activity is auxiliary to issue details.
    }
  }
  return events
}

export async function getIssueTimelineItems(
  repository: GitHubApiRepository,
  issueNumber: number,
  ghOptions: GitHubRepoExecOptions
): Promise<GitHubIssueTimelineItem[]> {
  try {
    const items: GitHubIssueTimelineItem[] = []
    for (let page = 1; items.length < MAX_ISSUE_TIMELINE_ITEMS; page += 1) {
      if (repositoryRateLimitGuard(repository, 'core', ghOptions).blocked) {
        return items
      }
      noteRepositoryRateLimitSpend(repository, 'core', 1, ghOptions)
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '60s',
          `repos/${repository.owner}/${repository.repo}/issues/${issueNumber}/timeline?per_page=${GITHUB_REST_PAGE_SIZE}&page=${page}`,
          '--jq',
          '.[] | @json'
        ],
        { ...ghOptions, ...githubHostExecOptions(repository) }
      )
      const pageEvents = parseRestTimelineEventLines(stdout)
      for (const event of pageEvents) {
        const item = mapRestTimelineEvent(event)
        if (!item) {
          continue
        }
        items.push(item)
        if (items.length === MAX_ISSUE_TIMELINE_ITEMS) {
          break
        }
      }
      if (pageEvents.length < GITHUB_REST_PAGE_SIZE) {
        break
      }
    }
    return items
  } catch {
    return []
  }
}
