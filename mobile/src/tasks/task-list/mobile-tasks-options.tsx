import type { PickerOption } from '../../components/sheets/PickerModal'
import { TaskProviderLogo } from '../../components/icons/TaskProviderLogo'
import {
  resolveJiraAutoName,
  resolveLinearAutoName,
  resolveWorkItemAutoName
} from '../../new-workspace/source-selection/composer-linked-work-item'
import type { GitHubProjectSettings } from '../project-board/github-project-reference'
import type { TaskProvider } from '../../../../src/shared/work-items/task-providers'
import type { GitHubProjectSortDirection } from '../../../../src/shared/github/projects/project-types'
import type { ProjectGroup } from '../../../../src/shared/github/projects/project-group-sort'
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
} from '../mobile-tasks-view-state-types'
import type { ActionableTaskItem } from '../mobile-tasks-project-workspace-types'
import type { LinearMobileIssue as LinearIssue } from '../providers/linear/linear-mobile-issue-read'
import type { Translate } from '../../i18n/mobile-i18n'
import type { MobilePalette } from '../../theme/mobile-theme'

export function taskProviderOptions(
  t: Translate,
  colors: MobilePalette
): PickerOption<TaskProvider>[] {
  return [
    {
      value: 'github',
      label: 'GitHub',
      subtitle: t('tasks.options.githubDescription', 'Issues and pull requests'),
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
      subtitle: t('tasks.options.gitlabDescription', 'Issues and merge requests'),
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
      subtitle: t('tasks.options.linearDescription', 'Assigned and team issues'),
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
      subtitle: t('tasks.options.jiraDescription', 'Assigned and reported issues'),
      renderIcon: (selected) => (
        <TaskProviderLogo
          provider="jira"
          size={16}
          color={selected ? colors.textPrimary : colors.textSecondary}
        />
      )
    }
  ]
}

export function gitlabFilterOptions(t: Translate): PickerOption<GitLabFilter>[] {
  return [
    {
      value: 'opened',
      label: t('tasks.options.openState', 'Open'),
      subtitle: t('tasks.options.gitlabOpenDescription', 'Open issues and merge requests')
    },
    {
      value: 'merged',
      label: t('tasks.options.mergedState', 'Merged'),
      subtitle: t('tasks.options.gitlabMergedDescription', 'Merged merge requests')
    },
    {
      value: 'closed',
      label: t('tasks.options.closedState', 'Closed'),
      subtitle: t('tasks.options.gitlabClosedDescription', 'Closed issues and merge requests')
    },
    {
      value: 'all',
      label: t('tasks.options.all', 'All'),
      subtitle: t('tasks.options.gitlabAllDescription', 'Any GitLab state')
    }
  ]
}

export function linearFilterOptions(t: Translate): PickerOption<LinearFilter>[] {
  return [
    {
      value: 'all',
      label: t('tasks.options.all', 'All'),
      subtitle: t('tasks.options.linearAllDescription', 'Open issues across connected workspaces')
    },
    {
      value: 'assigned',
      label: t('tasks.options.myIssues', 'My Issues'),
      subtitle: t('tasks.options.linearAssignedDescription', 'Issues assigned to you')
    },
    {
      value: 'created',
      label: t('tasks.options.createdState', 'Created'),
      subtitle: t('tasks.options.linearCreatedDescription', 'Issues created by you')
    },
    {
      value: 'completed',
      label: t('tasks.options.completedState', 'Completed'),
      subtitle: t('tasks.options.linearCompletedDescription', 'Recently completed issues')
    }
  ]
}

export function linearViewOptions(t: Translate): PickerOption<LinearViewMode>[] {
  return [
    {
      value: 'list',
      label: t('tasks.options.list', 'List'),
      subtitle: t('tasks.options.listDescription', 'Compact issue rows')
    },
    {
      value: 'board',
      label: t('tasks.options.board', 'Board'),
      subtitle: t('tasks.options.boardDescription', 'Grouped columns')
    }
  ]
}

export function taskWorkspaceFallback(item: ActionableTaskItem): string {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    return `${item.source.type}-${item.source.number}`
  }
  if (item.provider === 'jira') {
    return item.source.key.toLowerCase()
  }
  return item.source.identifier.toLowerCase()
}

// The composer's seed for the same source, so Start work names the workspace as desktop does.
function taskWorkspaceSeedName(item: ActionableTaskItem): string {
  switch (item.provider) {
    case 'github':
    case 'gitlab':
      return resolveWorkItemAutoName({
        type: item.source.type,
        number: item.source.number,
        title: item.source.title,
        provider: item.provider
      })
    case 'linear':
      return resolveLinearAutoName(item.source)
    case 'jira':
      return resolveJiraAutoName(item.source)
  }
}

export function taskWorkspaceSuggestedName(item: ActionableTaskItem): string {
  return taskWorkspaceSeedName(item) || taskWorkspaceFallback(item)
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

export function linearGroupOptions(t: Translate): PickerOption<LinearGroupBy>[] {
  return [
    { value: 'none', label: t('tasks.options.noGrouping', 'No grouping') },
    { value: 'status', label: t('tasks.options.status', 'Status') },
    { value: 'assignee', label: t('tasks.options.assignee', 'Assignee') },
    { value: 'priority', label: t('tasks.options.priority', 'Priority') },
    { value: 'team', label: t('tasks.options.team', 'Team') }
  ]
}

export function linearOrderOptions(t: Translate): PickerOption<LinearOrderBy>[] {
  return [
    { value: 'priority', label: t('tasks.options.priority', 'Priority') },
    { value: 'updated', label: t('tasks.options.updated', 'Updated') },
    { value: 'identifier', label: t('tasks.options.identifier', 'Identifier') }
  ]
}

export function linearDisplayOptions(t: Translate): PickerOption<LinearDisplayProperty>[] {
  return [
    { value: 'state', label: t('tasks.options.status', 'Status') },
    { value: 'priority', label: t('tasks.options.priority', 'Priority') },
    { value: 'assignee', label: t('tasks.options.assignee', 'Assignee') },
    { value: 'team', label: t('tasks.options.team', 'Team') },
    { value: 'labels', label: t('tasks.options.labels', 'Labels') },
    { value: 'updated', label: t('tasks.options.updated', 'Updated') }
  ]
}

export const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

export function githubKindOptions(t: Translate): PickerOption<GitHubMode>[] {
  return [
    {
      value: 'issues',
      label: t('tasks.options.issues', 'Issues'),
      subtitle: t('tasks.options.githubIssuesDescription', 'GitHub issues')
    },
    {
      value: 'prs',
      label: t('tasks.options.pullRequestsKind', 'Pull requests'),
      subtitle: t('tasks.options.githubPullRequestsDescription', 'GitHub pull requests')
    },
    {
      value: 'project',
      label: t('tasks.options.projects', 'Projects'),
      subtitle: t('tasks.options.githubProjectsDescription', 'GitHub Projects views')
    }
  ]
}

export function issuePresetOptions(t: Translate): PickerOption<GitHubPreset>[] {
  return [
    {
      value: 'issues',
      label: t('tasks.options.openState', 'Open'),
      subtitle: t('tasks.options.githubOpenIssuesDescription', 'Open GitHub issues')
    },
    {
      value: 'my-issues',
      label: t('tasks.options.assignedToMe', 'Assigned to me'),
      subtitle: t('tasks.options.githubAssignedIssuesDescription', 'Open issues assigned to you')
    }
  ]
}

export function prPresetOptions(t: Translate): PickerOption<GitHubPreset>[] {
  return [
    {
      value: 'prs',
      label: t('tasks.options.openState', 'Open'),
      subtitle: t('tasks.options.openPullRequestsDescription', 'Open pull requests')
    },
    {
      value: 'my-prs',
      label: t('tasks.options.mine', 'Mine'),
      subtitle: t('tasks.options.myPullRequestsDescription', 'Pull requests authored by you')
    },
    {
      value: 'review',
      label: t('tasks.options.needsReview', 'Needs review'),
      subtitle: t('tasks.options.reviewRequestsDescription', 'Review requests assigned to you')
    }
  ]
}

export function gitlabViewOptions(t: Translate): PickerOption<GitLabView>[] {
  return [
    {
      value: 'project',
      label: t('tasks.options.projectMergeRequests', 'Project MRs'),
      subtitle: t(
        'tasks.options.projectMergeRequestsDescription',
        'Merge requests and issues by repository'
      )
    },
    {
      value: 'todos',
      label: t('tasks.options.myTodos', 'My Todos'),
      subtitle: t('tasks.options.myTodosDescription', 'Pending GitLab todos')
    }
  ]
}

export function sortOptions(t: Translate): PickerOption<TaskSort>[] {
  return [
    {
      value: 'updated',
      label: t('tasks.options.updated', 'Updated'),
      subtitle: t('tasks.options.updatedSortDescription', 'Newest activity first')
    },
    {
      value: 'repository',
      label: t('tasks.options.repository', 'Repository'),
      subtitle: t(
        'tasks.options.repositorySortDescription',
        'Group by repository, then newest activity'
      )
    }
  ]
}

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

// The desktop runs four gh operations at once; more would wait there against the phone's 30 s request deadline.
export const GITHUB_REPO_CONCURRENCY = 4

export const MAX_RENDERED_PR_DIFF_LINES = 400

export const GITLAB_PER_PAGE = 50

export const LINEAR_LIMIT = 50

// Child sheets must layer over parents that remain mounted during dismissal.
export const TASK_SECONDARY_DRAWER_Z_INDEX = 1100

export const SHOW_MOBILE_DETAIL_LABEL_CHIPS = false

export const SHOW_MOBILE_DETAIL_METADATA_EDITORS = false

export const SHOW_MOBILE_DETAIL_REVIEW_PANELS = false

export const SHOW_MOBILE_COMMENT_THREAD_TOOLS = false

export const SHOW_MOBILE_PROJECT_METADATA_EDITORS = false

export const SHOW_MOBILE_PROJECT_REVIEW_PANELS = false

export const EMPTY_GITHUB_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}
