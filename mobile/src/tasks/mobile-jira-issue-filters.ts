import type { JiraIssueFilter } from '../../../src/shared/jira-types'

export const JIRA_FILTER_LABELS: Record<JiraIssueFilter, string> = {
  assigned: 'My Issues',
  reported: 'Reported',
  all: 'All',
  done: 'Done'
}

export function normalizeJiraFilter(value: unknown): JiraIssueFilter {
  return value === 'assigned' || value === 'reported' || value === 'done' || value === 'all'
    ? value
    : 'assigned'
}
