import {
  type PickerOption,
  type TaskProvider,
  TaskProviderLogo,
  colors,
  getLinkedWorkItemSuggestedName,
  type GitHubProjectSettings
} from './mobile-tasks-dependencies'
import type { GitHubProjectSortDirection } from '../../../src/shared/github/project-types'
import type { ProjectGroup } from '../../../src/shared/github/project-group-sort'
import type {
  GitHubMode,
  GitHubPreset,
  GitHubProjectRow,
  GitLabFilter,
  GitLabView,
  LinearDisplayProperty,
  LinearFilter,
  LinearGroupBy,
  LinearOrderBy,
  LinearViewMode,
  TaskSort
} from './mobile-tasks-view-state-types'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { LinearIssue } from './mobile-tasks-provider-detail-types'
import { translate } from '../i18n/mobile-i18n'

type TaskOptionCopy<T extends string> = Omit<PickerOption<T>, 'label' | 'subtitle'> & {
  label: string | (() => string)
  subtitle?: () => string
}

function localizedTaskOptions<T extends string>(options: TaskOptionCopy<T>[]): PickerOption<T>[] {
  return options.map(({ label, subtitle, ...option }) => ({
    ...option,
    get label() {
      return typeof label === 'string' ? label : label()
    },
    get subtitle() {
      return subtitle?.()
    }
  }))
}

export const PROVIDER_OPTIONS = localizedTaskOptions<TaskProvider>([
  {
    value: 'github',
    label: 'GitHub',
    subtitle: () => translate('tasks.options.githubDescription', 'Issues and pull requests'),
    renderIcon: (selected) => (
      <TaskProviderLogo
        provider="github"
        size={16}
        color={selected ? colors.textPrimary : colors.textSecondary}
      />
    )
  },
  {
    value: 'gitlab',
    label: 'GitLab',
    subtitle: () => translate('tasks.options.gitlabDescription', 'Issues and merge requests'),
    renderIcon: (selected) => (
      <TaskProviderLogo
        provider="gitlab"
        size={16}
        color={selected ? colors.textPrimary : colors.textSecondary}
      />
    )
  },
  {
    value: 'linear',
    label: 'Linear',
    subtitle: () => translate('tasks.options.linearDescription', 'Assigned and team issues'),
    renderIcon: (selected) => (
      <TaskProviderLogo
        provider="linear"
        size={16}
        color={selected ? colors.textPrimary : colors.textSecondary}
      />
    )
  },
  {
    value: 'jira',
    label: 'Jira',
    subtitle: () => translate('tasks.options.jiraDescription', 'Assigned and reported issues'),
    renderIcon: (selected) => (
      <TaskProviderLogo
        provider="jira"
        size={16}
        color={selected ? colors.textPrimary : colors.textSecondary}
      />
    )
  }
])

export const GITLAB_FILTER_OPTIONS = localizedTaskOptions<GitLabFilter>([
  {
    value: 'opened',
    label: () => translate('tasks.options.openState', 'Open'),
    subtitle: () =>
      translate('tasks.options.gitlabOpenDescription', 'Open issues and merge requests')
  },
  {
    value: 'merged',
    label: () => translate('tasks.options.mergedState', 'Merged'),
    subtitle: () => translate('tasks.options.gitlabMergedDescription', 'Merged merge requests')
  },
  {
    value: 'closed',
    label: () => translate('tasks.options.closedState', 'Closed'),
    subtitle: () =>
      translate('tasks.options.gitlabClosedDescription', 'Closed issues and merge requests')
  },
  {
    value: 'all',
    label: () => translate('tasks.options.all', 'All'),
    subtitle: () => translate('tasks.options.gitlabAllDescription', 'Any GitLab state')
  }
])

export const LINEAR_FILTER_OPTIONS = localizedTaskOptions<LinearFilter>([
  {
    value: 'all',
    label: () => translate('tasks.options.all', 'All'),
    subtitle: () =>
      translate('tasks.options.linearAllDescription', 'Open issues across connected workspaces')
  },
  {
    value: 'assigned',
    label: () => translate('tasks.options.myIssues', 'My Issues'),
    subtitle: () => translate('tasks.options.linearAssignedDescription', 'Issues assigned to you')
  },
  {
    value: 'created',
    label: () => translate('tasks.options.createdState', 'Created'),
    subtitle: () => translate('tasks.options.linearCreatedDescription', 'Issues created by you')
  },
  {
    value: 'completed',
    label: () => translate('tasks.options.completedState', 'Completed'),
    subtitle: () =>
      translate('tasks.options.linearCompletedDescription', 'Recently completed issues')
  }
])

export const LINEAR_VIEW_OPTIONS = localizedTaskOptions<LinearViewMode>([
  {
    value: 'list',
    label: () => translate('tasks.options.list', 'List'),
    subtitle: () => translate('tasks.options.listDescription', 'Compact issue rows')
  },
  {
    value: 'board',
    label: () => translate('tasks.options.board', 'Board'),
    subtitle: () => translate('tasks.options.boardDescription', 'Grouped columns')
  }
])

export function taskWorkspaceFallback(item: ActionableTaskItem): string {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    return `${item.source.type}-${item.source.number}`
  }
  if (item.provider === 'jira') {
    return item.source.key.toLowerCase()
  }
  return item.source.identifier.toLowerCase()
}

export function taskWorkspaceSuggestedName(item: ActionableTaskItem): string {
  return getLinkedWorkItemSuggestedName(item) || taskWorkspaceFallback(item)
}

// Keep provider reaction content unchanged; this legacy emoji map does not match GitHub tokens or GitLab’s absent content.
export const COMMENT_REACTION_EMOJI: Record<string, string> = {
  thumbs_up: '+1',
  thumbs_down: '-1',
  laugh: 'laugh',
  confused: 'confused',
  heart: 'heart',
  hooray: 'hooray',
  rocket: 'rocket',
  eyes: 'eyes'
}

export const LINEAR_GROUP_OPTIONS = localizedTaskOptions<LinearGroupBy>([
  { value: 'none', label: () => translate('tasks.options.noGrouping', 'No grouping') },
  { value: 'status', label: () => translate('tasks.options.status', 'Status') },
  { value: 'assignee', label: () => translate('tasks.options.assignee', 'Assignee') },
  { value: 'priority', label: () => translate('tasks.options.priority', 'Priority') },
  { value: 'team', label: () => translate('tasks.options.team', 'Team') }
])

export const LINEAR_ORDER_OPTIONS = localizedTaskOptions<LinearOrderBy>([
  { value: 'priority', label: () => translate('tasks.options.priority', 'Priority') },
  { value: 'updated', label: () => translate('tasks.options.updated', 'Updated') },
  { value: 'identifier', label: () => translate('tasks.options.identifier', 'Identifier') }
])

export const LINEAR_DISPLAY_OPTIONS = localizedTaskOptions<LinearDisplayProperty>([
  { value: 'state', label: () => translate('tasks.options.status', 'Status') },
  { value: 'priority', label: () => translate('tasks.options.priority', 'Priority') },
  { value: 'assignee', label: () => translate('tasks.options.assignee', 'Assignee') },
  { value: 'team', label: () => translate('tasks.options.team', 'Team') },
  { value: 'labels', label: () => translate('tasks.options.labels', 'Labels') },
  { value: 'updated', label: () => translate('tasks.options.updated', 'Updated') }
])

export const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

export const GITHUB_KIND_OPTIONS = localizedTaskOptions<GitHubMode>([
  {
    value: 'issues',
    label: () => translate('tasks.options.issues', 'Issues'),
    subtitle: () => translate('tasks.options.githubIssuesDescription', 'GitHub issues')
  },
  {
    value: 'prs',
    label: () => translate('tasks.options.pullRequests', 'PRs'),
    subtitle: () => translate('tasks.options.githubPullRequestsDescription', 'GitHub pull requests')
  },
  {
    value: 'project',
    label: () => translate('tasks.options.projects', 'Projects'),
    subtitle: () => translate('tasks.options.githubProjectsDescription', 'GitHub Projects views')
  }
])

export const ISSUE_PRESETS = localizedTaskOptions<GitHubPreset>([
  {
    value: 'issues',
    label: () => translate('tasks.options.openState', 'Open'),
    subtitle: () => translate('tasks.options.githubOpenIssuesDescription', 'Open GitHub issues')
  },
  {
    value: 'my-issues',
    label: () => translate('tasks.options.assignedToMe', 'Assigned to me'),
    subtitle: () =>
      translate('tasks.options.githubAssignedIssuesDescription', 'Open issues assigned to you')
  }
])

export const PR_PRESETS = localizedTaskOptions<GitHubPreset>([
  {
    value: 'prs',
    label: () => translate('tasks.options.openState', 'Open'),
    subtitle: () => translate('tasks.options.openPullRequestsDescription', 'Open pull requests')
  },
  {
    value: 'my-prs',
    label: () => translate('tasks.options.mine', 'Mine'),
    subtitle: () =>
      translate('tasks.options.myPullRequestsDescription', 'Pull requests authored by you')
  },
  {
    value: 'review',
    label: () => translate('tasks.options.needsReview', 'Needs review'),
    subtitle: () =>
      translate('tasks.options.reviewRequestsDescription', 'Review requests assigned to you')
  }
])

export const GITLAB_VIEW_OPTIONS = localizedTaskOptions<GitLabView>([
  {
    value: 'project',
    label: () => translate('tasks.options.projectMergeRequests', 'Project MRs'),
    subtitle: () =>
      translate(
        'tasks.options.projectMergeRequestsDescription',
        'Merge requests and issues by repository'
      )
  },
  {
    value: 'todos',
    label: () => translate('tasks.options.myTodos', 'My Todos'),
    subtitle: () => translate('tasks.options.myTodosDescription', 'Pending GitLab todos')
  }
])

export const SORT_OPTIONS = localizedTaskOptions<TaskSort>([
  {
    value: 'updated',
    label: () => translate('tasks.options.updated', 'Updated'),
    subtitle: () => translate('tasks.options.updatedSortDescription', 'Newest activity first')
  },
  {
    value: 'repository',
    label: () => translate('tasks.options.repository', 'Repository'),
    subtitle: () =>
      translate(
        'tasks.options.repositorySortDescription',
        'Group by repository, then newest activity'
      )
  }
])

export type ProjectSortOverride = { fieldId: string; direction: GitHubProjectSortDirection }

export type ProjectListEntry =
  | { type: 'group'; group: ProjectGroup; collapsed: boolean }
  | { type: 'row'; row: GitHubProjectRow }

export type LinearIssueSection = {
  key: string
  label: string
  color: string
  issues: LinearIssue[]
}

export type LinearListEntry =
  | { type: 'section'; section: LinearIssueSection }
  | { type: 'issue'; issue: LinearIssue }

export const PROJECT_VIEW_DEFAULT_SORT = '__view_default__'

export const GITHUB_REPO_CONCURRENCY = 3

export const MAX_RENDERED_PR_DIFF_LINES = 400

export const GITLAB_PER_PAGE = 50

export const LINEAR_LIMIT = 50

// Child sheets must layer over parents that remain mounted during dismissal.
export const TASK_SECONDARY_DRAWER_Z_INDEX = 1100

export const SHOW_MOBILE_DETAIL_LABEL_CHIPS = false

export const SHOW_MOBILE_DETAIL_METADATA_EDITORS = false

export const SHOW_MOBILE_DETAIL_REVIEW_PANELS = false

export const SHOW_MOBILE_LINEAR_DETAIL_TOOLS = false

export const SHOW_MOBILE_COMMENT_THREAD_TOOLS = false

export const SHOW_MOBILE_PROJECT_METADATA_EDITORS = false

export const SHOW_MOBILE_PROJECT_REVIEW_PANELS = false

export const EMPTY_GITHUB_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}
