import { colors } from '../theme/mobile-theme'
import type { LinearMobileIssue } from './linear-mobile-issue-read'
import { getLinearPriorityLabel, getLinearPriorityRank } from './mobile-linear-issue-priority'
import type { LinearGroupBy, LinearOrderBy } from './mobile-task-view-options'

export type LinearIssueSection = {
  key: string
  label: string
  color: string
  issues: LinearMobileIssue[]
}

function updatedTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function compareLinearIssues(
  a: LinearMobileIssue,
  b: LinearMobileIssue,
  orderBy: LinearOrderBy
): number {
  if (orderBy === 'updated') {
    return updatedTime(b.updatedAt) - updatedTime(a.updatedAt)
  }
  if (orderBy === 'identifier') {
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  }
  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  return priorityDelta || updatedTime(b.updatedAt) - updatedTime(a.updatedAt)
}

function getLinearIssueGroup(
  issue: LinearMobileIssue,
  groupBy: LinearGroupBy
): { key: string; label: string; color: string } {
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
  issues: LinearMobileIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearIssueSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'Issues', color: colors.accentBlue, issues: sorted }]
  }
  const sections = new Map<string, LinearIssueSection>()
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
