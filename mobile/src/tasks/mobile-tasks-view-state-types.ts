import type { DetailComment } from './mobile-tasks-provider-detail-types'
import type {
  TuiAgent,
  TaskProvider,
  GitHubProjectSettings,
  GitHubProjectRef
} from './mobile-tasks-dependencies'
import type { GitHubProjectSortDirection } from '../../../src/shared/github/project-types'

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

export type DetailCommentGroup =
  | { kind: 'standalone'; comment: DetailComment }
  | { kind: 'thread'; threadId: string; root: DetailComment; replies: DetailComment[] }

export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: GitHubPreset | 'all' | null
  githubItemsQuery?: string
  githubProjectHiddenFieldIdsByView?: Record<string, string[]>
  linearPreset?: LinearFilter
  linearQuery?: string
}

export type RuntimeTaskSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
  agentCmdOverrides?: Record<string, string>
  defaultTaskSource?: TaskProvider
  defaultTaskViewPreset?: GitHubPreset | 'all'
  visibleTaskProviders?: TaskProvider[]
  defaultRepoSelection?: string[] | null
  defaultLinearTeamSelection?: string[] | null
  githubProjects?: GitHubProjectSettings
}

export type LinearWorkspace = {
  id: string
  organizationName?: string
  displayName?: string
}

export type LinearStatusResponse = {
  connected?: boolean
  workspaces?: LinearWorkspace[]
  selectedWorkspaceId?: string | 'all' | null
  activeWorkspaceId?: string | null
}

export type GitHubIssueType = {
  id: string
  name: string
  color: string | null
  description: string | null
}

export type GitHubProjectField =
  | {
      kind: 'field'
      id: string
      name: string
      dataType: string
    }
  | {
      kind: 'single-select'
      id: string
      name: string
      dataType: 'SINGLE_SELECT'
      options: Array<{ id: string; name: string; color: string }>
    }
  | {
      kind: 'iteration'
      id: string
      name: string
      dataType: 'ITERATION'
      iterations: Array<{
        id: string
        title: string
        startDate: string
        duration: number
        completed?: boolean
      }>
    }

export type GitHubProjectSort = {
  direction: GitHubProjectSortDirection
  field: GitHubProjectField
}

export type GitHubProjectFieldValue =
  | { kind: 'single-select'; fieldId: string; optionId: string; name: string; color: string }
  | {
      kind: 'iteration'
      fieldId: string
      iterationId: string
      title: string
      startDate: string
      duration: number
    }
  | { kind: 'text'; fieldId: string; text: string }
  | { kind: 'number'; fieldId: string; number: number }
  | { kind: 'date'; fieldId: string; date: string }
  | { kind: 'labels'; fieldId: string; labels: Array<{ name: string; color: string }> }
  | { kind: 'users'; fieldId: string; users: Array<{ login: string; name: string | null }> }

export type GitHubProjectFieldMutationValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'date'; date: string }
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }

export type GitHubProjectRow = {
  id: string
  itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  content: {
    number: number | null
    title: string
    body: string | null
    url: string | null
    state: string | null
    stateReason?: string | null
    isDraft: boolean | null
    repository: string | null
    issueType?: GitHubIssueType | null
    labels: Array<{ name: string; color: string }>
    assignees: Array<{ login: string; name: string | null }>
    parentIssue?: { number: number; title: string; url: string } | null
  }
  fieldValuesByFieldId?: Record<string, GitHubProjectFieldValue>
  updatedAt: string
  position?: number
}

export type GitHubProjectTable = {
  project: GitHubProjectRef & {
    id: string
    title: string
    url: string
  }
  selectedView: {
    id: string
    number: number
    name: string
    filter: string
    layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
    fields?: GitHubProjectField[]
    groupByFields?: GitHubProjectField[]
    sortByFields?: GitHubProjectSort[]
  }
  rows: GitHubProjectRow[]
  totalCount: number
  parentFieldDropped?: boolean
}
