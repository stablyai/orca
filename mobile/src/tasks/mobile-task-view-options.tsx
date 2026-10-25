import type { JiraIssueFilter } from '../../../src/shared/jira/jira-types'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type { PickerOption } from '../components/PickerModal'
import { JIRA_FILTER_LABELS } from './mobile-jira-issue-filters'

export const PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

export const PROVIDER_EMPTY_LABELS: Record<TaskProvider, string> = {
  github: 'No GitHub tasks',
  gitlab: 'No GitLab tasks',
  linear: 'No Linear tasks',
  jira: 'No Jira tasks'
}

export const JIRA_FILTER_OPTIONS: PickerOption<JiraIssueFilter>[] = [
  {
    value: 'assigned',
    label: JIRA_FILTER_LABELS.assigned,
    subtitle: 'Unresolved issues assigned to you'
  },
  {
    value: 'reported',
    label: JIRA_FILTER_LABELS.reported,
    subtitle: 'Unresolved issues you reported'
  },
  {
    value: 'all',
    label: JIRA_FILTER_LABELS.all,
    subtitle: 'Unresolved issues across the selected sites'
  },
  { value: 'done', label: JIRA_FILTER_LABELS.done, subtitle: 'Your recently resolved issues' }
]
