import { type GitHubOwnerRepo, colors } from './mobile-tasks-dependencies'
import { getLinearPriorityLabel, getLinearPriorityRank } from './mobile-tasks-hosted-review'
import { formatUpdatedAt, taskTime } from './mobile-tasks-item-mapping'
import type { LinearIssueSection } from './mobile-tasks-options'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearOrderBy
} from './mobile-tasks-view-state-types'
import type {
  GitHubAssignableUser,
  GitHubPRReviewSummary,
  GitHubRepoSources,
  LinearIssue,
  LinearTeam
} from './mobile-tasks-provider-detail-types'

export function mergeGitHubAssignableUsers(
  users: GitHubAssignableUser[],
  seeds: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of [...users, ...seeds]) {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      continue
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  return [...byLogin.values()]
}

export function getGitHubReviewerSeedUsers(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  author?: string | null
}): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  const add = (user: GitHubAssignableUser): void => {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      return
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  for (const user of item.reviewRequests ?? []) {
    add(user)
  }
  for (const review of item.latestReviews ?? []) {
    add({
      login: review.login,
      name: null,
      avatarUrl: review.avatarUrl ?? null
    })
  }
  if (item.author) {
    add({ login: item.author, name: null, avatarUrl: null })
  }
  return [...byLogin.values()]
}

export function sameGitHubOwnerRepo(
  a: GitHubOwnerRepo | null | undefined,
  b: GitHubOwnerRepo | null | undefined
): boolean {
  return (
    !!a &&
    !!b &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

export function hasGitHubIssueSourceChoice(sources: GitHubRepoSources | undefined): boolean {
  return Boolean(
    sources?.prs &&
    sources.upstreamCandidate &&
    !sameGitHubOwnerRepo(sources.prs, sources.upstreamCandidate)
  )
}

export function issueSourceSlug(source: GitHubOwnerRepo | null | undefined): string {
  return source ? `${source.owner}/${source.repo}` : 'Unknown'
}

export function compareLinearIssues(
  a: LinearIssue,
  b: LinearIssue,
  orderBy: LinearOrderBy
): number {
  if (orderBy === 'updated') {
    return taskTime(b.updatedAt) - taskTime(a.updatedAt)
  }
  if (orderBy === 'identifier') {
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  }
  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  return priorityDelta || taskTime(b.updatedAt) - taskTime(a.updatedAt)
}

export function getLinearIssueGroup(
  issue: LinearIssue,
  groupBy: LinearGroupBy
): {
  key: string
  label: string
  color: string
} {
  if (groupBy === 'status') {
    return { key: `status:${issue.state.name}`, label: issue.state.name, color: issue.state.color }
  }
  if (groupBy === 'assignee') {
    return {
      key: `assignee:${issue.assignee?.id ?? issue.assignee?.displayName ?? 'unassigned'}`,
      label: issue.assignee?.displayName ?? 'Unassigned',
      color: colors.accentBlue
    }
  }
  if (groupBy === 'priority') {
    return {
      key: `priority:${issue.priority}`,
      label: getLinearPriorityLabel(issue.priority),
      color: issue.priority === 1 ? colors.statusRed : colors.accentBlue
    }
  }
  if (groupBy === 'team') {
    return { key: `team:${issue.team.id}`, label: issue.team.name, color: issue.state.color }
  }
  return { key: 'all', label: 'Issues', color: colors.accentBlue }
}

export function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearIssueSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'Issues', color: colors.accentBlue, issues: sorted }]
  }
  const sections = new Map<
    string,
    { key: string; label: string; color: string; issues: LinearIssue[] }
  >()
  for (const issue of sorted) {
    const group = getLinearIssueGroup(issue, groupBy)
    const section = sections.get(group.key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(group.key, { ...group, issues: [issue] })
    }
  }
  return [...sections.values()]
}

export function linearIssueSecondaryParts(
  issue: LinearIssue,
  displayProperties: ReadonlySet<LinearDisplayProperty>
): string[] {
  const parts = [issue.identifier]
  if (displayProperties.has('priority')) {
    parts.push(getLinearPriorityLabel(issue.priority))
  }
  if (displayProperties.has('assignee') && issue.assignee?.displayName) {
    parts.push(issue.assignee.displayName)
  }
  if (displayProperties.has('team')) {
    parts.push(issue.team.name)
  }
  if (displayProperties.has('labels') && issue.labels.length > 0) {
    parts.push(issue.labels.slice(0, 2).join(', '))
  }
  if (displayProperties.has('updated')) {
    parts.push(formatUpdatedAt(issue.updatedAt))
  }
  return parts
}

export function reconcileTeamSelection(
  teams: LinearTeam[],
  saved: string[] | null | undefined
): Set<string> {
  if (!saved) {
    return new Set(teams.map((team) => team.id))
  }
  const available = new Set(teams.map((team) => team.id))
  const next = new Set(saved.filter((id) => available.has(id)))
  return next.size === 0 ? new Set(teams.map((team) => team.id)) : next
}

export function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function splitReviewerList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}
