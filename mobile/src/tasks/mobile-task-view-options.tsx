import type { TaskProvider } from '../../../src/shared/task-providers'
import type { PickerOption } from '../components/PickerModal'
import { TaskProviderLogo } from '../components/TaskProviderLogo'
import { colors } from '../theme/mobile-theme'

export type GitHubTaskKind = 'issues' | 'prs'
export type GitHubMode = GitHubTaskKind | 'project'
export type GitHubPreset = 'issues' | 'my-issues' | 'prs' | 'my-prs' | 'review'
export type GitLabView = 'project' | 'todos'
export type GitLabFilter = 'opened' | 'merged' | 'closed' | 'all'
export type LinearFilter = 'assigned' | 'created' | 'all' | 'completed'
export type LinearViewMode = 'list' | 'board'
export type LinearGroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'team'
export type LinearOrderBy = 'priority' | 'updated' | 'identifier'
export type LinearDisplayProperty =
  | 'state'
  | 'priority'
  | 'assignee'
  | 'team'
  | 'labels'
  | 'updated'
export type TaskSort = 'updated' | 'repository'

function providerIcon(provider: TaskProvider) {
  return (selected: boolean) => (
    <TaskProviderLogo
      provider={provider}
      size={16}
      color={selected ? colors.textPrimary : colors.textSecondary}
    />
  )
}

export const PROVIDER_OPTIONS: PickerOption<TaskProvider>[] = [
  {
    value: 'github',
    label: 'GitHub',
    subtitle: 'Issues and pull requests',
    renderIcon: providerIcon('github')
  },
  {
    value: 'gitlab',
    label: 'GitLab',
    subtitle: 'Issues and merge requests',
    renderIcon: providerIcon('gitlab')
  },
  {
    value: 'linear',
    label: 'Linear',
    subtitle: 'Assigned and team issues',
    renderIcon: providerIcon('linear')
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
