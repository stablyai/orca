import type { JiraIssueFilter } from '../../../src/shared/jira/jira-types'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type { PickerOption } from '../components/PickerModal'
import { translate } from '../i18n/mobile-i18n'
import { JIRA_FILTER_LABELS } from './mobile-jira-issue-filters'

export const PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

export const PROVIDER_EMPTY_LABELS: Record<TaskProvider, string> = {
  get github() {
    return translate('tasks.taskViewOptions.noGitHubTasks', 'No GitHub tasks')
  },
  get gitlab() {
    return translate('tasks.taskViewOptions.noGitLabTasks', 'No GitLab tasks')
  },
  get linear() {
    return translate('tasks.taskViewOptions.noLinearTasks', 'No Linear tasks')
  },
  get jira() {
    return translate('tasks.taskViewOptions.noJiraTasks', 'No Jira tasks')
  }
}

export const JIRA_FILTER_OPTIONS: PickerOption<JiraIssueFilter>[] = [
  {
    value: 'assigned',
    get label() {
      return JIRA_FILTER_LABELS.assigned
    },
    get subtitle() {
      return translate(
        'tasks.taskViewOptions.assignedSubtitle',
        'Unresolved issues assigned to you'
      )
    }
  },
  {
    value: 'reported',
    get label() {
      return JIRA_FILTER_LABELS.reported
    },
    get subtitle() {
      return translate('tasks.taskViewOptions.reportedSubtitle', 'Unresolved issues you reported')
    }
  },
  {
    value: 'all',
    get label() {
      return JIRA_FILTER_LABELS.all
    },
    get subtitle() {
      return translate(
        'tasks.taskViewOptions.allSubtitle',
        'Unresolved issues across the selected sites'
      )
    }
  },
  {
    value: 'done',
    get label() {
      return JIRA_FILTER_LABELS.done
    },
    get subtitle() {
      return translate('tasks.taskViewOptions.doneSubtitle', 'Your recently resolved issues')
    }
  }
]
