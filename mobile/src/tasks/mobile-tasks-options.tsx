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
import type { DetailComment, LinearIssue } from './mobile-tasks-provider-detail-types'

export const PROVIDER_OPTIONS: PickerOption<TaskProvider>[] = [
  {
    value: 'github',
    label: 'GitHub',
    subtitle: 'Issues and pull requests',
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
    subtitle: 'Issues and merge requests',
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
    subtitle: 'Assigned and team issues',
    renderIcon: (selected) => (
      <TaskProviderLogo
        provider="linear"
        size={16}
        color={selected ? colors.textPrimary : colors.textSecondary}
      />
    )
  }
]

export const GITLAB_FILTER_OPTIONS: PickerOption<GitLabFilter>[] = [
  { value: 'opened', label: 'Open', subtitle: 'Open issues and merge requests' },
  { value: 'merged', label: 'Merged', subtitle: 'Merged merge requests' },
  { value: 'closed', label: 'Closed', subtitle: 'Closed issues and merge requests' },
  { value: 'all', label: 'All', subtitle: 'Any GitLab state' }
]

export const LINEAR_FILTER_OPTIONS: PickerOption<LinearFilter>[] = [
  { value: 'all', label: 'All', subtitle: 'Open issues across connected workspaces' },
  { value: 'assigned', label: 'My Issues', subtitle: 'Issues assigned to you' },
  { value: 'created', label: 'Created', subtitle: 'Issues created by you' },
  { value: 'completed', label: 'Completed', subtitle: 'Recently completed issues' }
]

export const LINEAR_VIEW_OPTIONS: PickerOption<LinearViewMode>[] = [
  { value: 'list', label: 'List', subtitle: 'Compact issue rows' },
  { value: 'board', label: 'Board', subtitle: 'Grouped columns' }
]

export function taskWorkspaceFallback(item: ActionableTaskItem): string {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    return `${item.source.type}-${item.source.number}`
  }
  return item.source.identifier.toLowerCase()
}

export function taskWorkspaceSuggestedName(item: ActionableTaskItem): string {
  return getLinkedWorkItemSuggestedName(item) || taskWorkspaceFallback(item)
}

export const COMMENT_REACTION_EMOJI: Record<
  NonNullable<DetailComment['reactions']>[number]['content'],
  string
> = {
  thumbs_up: '+1',
  thumbs_down: '-1',
  laugh: 'laugh',
  confused: 'confused',
  heart: 'heart',
  hooray: 'hooray',
  rocket: 'rocket',
  eyes: 'eyes'
}

export const LINEAR_GROUP_OPTIONS: PickerOption<LinearGroupBy>[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Status' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'priority', label: 'Priority' },
  { value: 'team', label: 'Team' }
]

export const LINEAR_ORDER_OPTIONS: PickerOption<LinearOrderBy>[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Updated' },
  { value: 'identifier', label: 'Identifier' }
]

export const LINEAR_DISPLAY_OPTIONS: PickerOption<LinearDisplayProperty>[] = [
  { value: 'state', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'team', label: 'Team' },
  { value: 'labels', label: 'Labels' },
  { value: 'updated', label: 'Updated' }
]

export const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

export const GITHUB_KIND_OPTIONS: PickerOption<GitHubMode>[] = [
  { value: 'issues', label: 'Issues', subtitle: 'GitHub issues' },
  { value: 'prs', label: 'PRs', subtitle: 'GitHub pull requests' },
  { value: 'project', label: 'Projects', subtitle: 'GitHub Projects views' }
]

export const ISSUE_PRESETS: PickerOption<GitHubPreset>[] = [
  { value: 'issues', label: 'Open', subtitle: 'Open GitHub issues' },
  { value: 'my-issues', label: 'Assigned to me', subtitle: 'Open issues assigned to you' }
]

export const PR_PRESETS: PickerOption<GitHubPreset>[] = [
  { value: 'prs', label: 'Open', subtitle: 'Open pull requests' },
  { value: 'my-prs', label: 'Mine', subtitle: 'Pull requests authored by you' },
  { value: 'review', label: 'Needs review', subtitle: 'Review requests assigned to you' }
]

export const GITLAB_VIEW_OPTIONS: PickerOption<GitLabView>[] = [
  { value: 'project', label: 'Project MRs', subtitle: 'Merge requests and issues by repository' },
  { value: 'todos', label: 'My Todos', subtitle: 'Pending GitLab todos' }
]

export const SORT_OPTIONS: PickerOption<TaskSort>[] = [
  { value: 'updated', label: 'Updated', subtitle: 'Newest activity first' },
  {
    value: 'repository',
    label: 'Repository',
    subtitle: 'Group by repository, then newest activity'
  }
]

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

// Why: task detail drawers can launch child sheets; children must layer above
// the still-mounted parent while its dismissal animation/state remains alive.
export const TASK_SECONDARY_DRAWER_Z_INDEX = 1100

// Why: the mobile detail drawer should support quick triage and core actions.
// Desktop keeps the broad metadata editing surface for dense issue/PR work.
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
