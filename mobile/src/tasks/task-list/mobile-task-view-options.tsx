import type { JiraIssueFilter } from '../../../../src/shared/jira/jira-types'
import type { TaskProvider } from '../../../../src/shared/work-items/task-providers'
import type { PickerOption } from '../../components/sheets/PickerModal'
import type { Translate } from '../../i18n/mobile-i18n'
import { JIRA_FILTER_LABELS } from '../providers/jira/mobile-jira-issue-filters'

export const PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

export function providerEmptyLabel(t: Translate, provider: TaskProvider): string {
  switch (provider) {
    case 'github':
      return t('tasks.taskViewOptions.noGitHubTasks', 'No GitHub tasks')
    case 'gitlab':
      return t('tasks.taskViewOptions.noGitLabTasks', 'No GitLab tasks')
    case 'linear':
      return t('tasks.taskViewOptions.noLinearTasks', 'No Linear tasks')
    case 'jira':
      return t('tasks.taskViewOptions.noJiraTasks', 'No Jira tasks')
  }
}

export function jiraFilterOptions(t: Translate): PickerOption<JiraIssueFilter>[] {
  return [
    {
      value: 'assigned',
      label: JIRA_FILTER_LABELS.assigned,
      subtitle: t('tasks.taskViewOptions.assignedSubtitle', 'Unresolved issues assigned to you')
    },
    {
      value: 'reported',
      label: JIRA_FILTER_LABELS.reported,
      subtitle: t('tasks.taskViewOptions.reportedSubtitle', 'Unresolved issues you reported')
    },
    {
      value: 'all',
      label: JIRA_FILTER_LABELS.all,
      subtitle: t(
        'tasks.taskViewOptions.allSubtitle',
        'Unresolved issues across the selected sites'
      )
    },
    {
      value: 'done',
      label: JIRA_FILTER_LABELS.done,
      subtitle: t('tasks.taskViewOptions.doneSubtitle', 'Your recently resolved issues')
    }
  ]
}
