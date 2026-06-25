import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  GitBranch,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  X
} from 'lucide-react-native'
import type { RpcClient } from '../../../src/transport/rpc-client'
import type { RpcSuccess } from '../../../src/transport/types'
import {
  useHostClient,
  useLastConnectedAt,
  useReconnectAttempt
} from '../../../src/transport/client-context'
import { classifyConnection } from '../../../src/transport/connection-health'
import { StatusDot } from '../../../src/components/StatusDot'
import { ActionSheetModal } from '../../../src/components/ActionSheetModal'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { MobileMarkdown } from '../../../src/components/MobileMarkdown'
import { MobileAgentIcon } from '../../../src/components/MobileAgentIcon'
import { MobileWorkspaceNameInput } from '../../../src/components/MobileWorkspaceNameInput'
import { MobileSyntaxSegments } from '../../../src/components/MobileSyntaxSegments'
import { PickerModal, type PickerOption } from '../../../src/components/PickerModal'
import { TaskProviderLogo } from '../../../src/components/TaskProviderLogo'
import {
  buildGitHubPrFileDiffPreview,
  type GitHubPrFileDiffLine
} from '../../../src/tasks/github-pr-file-diff'
import {
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from '../../../src/session/mobile-file-syntax'
import { buildGitHubCheckSummary } from '../../../src/tasks/github-check-summary'
import { buildTaskWorkspaceCreateParams } from '../../../src/tasks/workspace-create-params'
import {
  filterWorkspaceAgents,
  isWorkspaceAgentEnabled,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection,
  workspaceAgentLabel,
  type WorkspaceAgentChoice
} from '../../../src/tasks/workspace-agent-selection'
import { shouldResolveHostedReviewStartPoint } from '../../../src/tasks/hosted-review-start-point'
import { getLinkedWorkItemSuggestedName } from '../../../src/tasks/mobile-workspace-name'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  type GitHubRepoSlugCacheEntry
} from '../../../src/tasks/github-project-repo-match'
import {
  extractGitHubIssueSourceFallback,
  extractGitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  type GitHubIssueSourceError
} from '../../../src/tasks/github-work-item-source-errors'
import { parseSparsePresetDirectories } from '../../../src/tasks/sparse-preset-draft'
import {
  deriveWorkspaceSshGate,
  workspaceSshStatusLabel
} from '../../../src/tasks/workspace-ssh-gate'
import { WORKTREE_CREATE_TIMEOUT_MS } from '../../../src/tasks/workspace-create-timeout'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  trustedOrcaHooksWithSetupApproval,
  wasSetupHookPreviouslyApproved
} from '../../../src/tasks/setup-hook-trust'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { triggerMediumImpact } from '../../../src/platform/haptics'
import type {
  GitHubProjectSortDirection,
  GitHubProjectTable as SharedGitHubProjectTable
} from '../../../src/tasks/mobile-github-project-group-sort'
import {
  groupRows,
  isIterationCurrent,
  sortRows,
  type ProjectGroup
} from '../../../src/tasks/mobile-github-project-group-sort'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  isGitHubWorkItemsSshRemoteRequiredError,
  PER_REPO_FETCH_LIMIT
} from '../../../src/tasks/mobile-work-items'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider,
  type TaskProvider
} from '../../../src/tasks/mobile-task-providers'
import {
  extractLinearIssueReadItems,
  type LinearMobileIssue
} from '../../../src/tasks/linear-mobile-issue-read'
import { MOBILE_TUI_AGENT_AUTO_PICK_ORDER } from '../../../src/tasks/mobile-tui-agents'
import { resolveComposerBranchSelection } from '../../../src/tasks/mobile-composer-branch-selection'
import {
  clearMobileTaskCopyFeedbackTimer,
  scheduleMobileTaskCopyFeedbackReset
} from '../../../src/tasks/mobile-task-copy-feedback-timer'
import type {
  BaseRefSearchResult,
  PersistedTrustedOrcaHooks,
  SparsePreset,
  TuiAgent
} from '../../../../src/shared/types'
import type { SshConnectionState } from '../../../../src/shared/ssh-types'

type RepoSummary = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  kind?: 'git' | 'folder'
  connectionId?: string | null
  issueSourcePreference?: IssueSourcePreference
}

type IssueSourcePreference = 'upstream' | 'origin' | 'auto'

type GitHubOwnerRepo = {
  owner: string
  repo: string
}

type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  repoId: string
  repoName: string
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  checksSummary?: GitHubPRCheckSummary
  mergeable?: GitHubPRMergeableState
  mergeStateStatus?: string | null
}

type GitHubAssignableUser = {
  login: string
  name?: string | null
  avatarUrl?: string | null
}

type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}

type GitHubPRCheckSummary = {
  state: 'success' | 'failure' | 'pending' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
}

type GitHubPRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

type GitHubPRReviewerRow = {
  login: string
  name?: string | null
  avatarUrl?: string | null
  stateLabel: string
}

type GitHubRepoSources = {
  issues: GitHubOwnerRepo | null
  prs: GitHubOwnerRepo | null
  upstreamCandidate: GitHubOwnerRepo | null
}

type TaskRuntimeStatus = {
  capabilities?: string[]
}

type TasksSupportState =
  | { kind: 'unknown'; client: RpcClient | null }
  | { kind: 'supported'; client: RpcClient }
  | { kind: 'unsupported'; client: RpcClient }

type GitLabWorkItem = {
  id: string
  type: 'issue' | 'mr'
  number: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  projectRef?: { host: string; path: string }
  repoId: string
  repoName: string
}

type GitLabTodo = {
  id: number
  actionName: string
  targetType: string
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  projectPath: string
  authorUsername: string
  updatedAt: string
  state: 'pending' | 'done'
}

type GitPushTarget = {
  remoteName: string
  branchName: string
  remoteUrl?: string
}

type SetupDecision = 'inherit' | 'run' | 'skip'
type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: {
    contentHash: string
    scriptContent: string
  }
}

type LinearProject = {
  id: string
  name: string
  url?: string
  color?: string
}

type LinearIssueChild = {
  id: string
  identifier: string
  title: string
  url: string
}

type LinearIssue = LinearMobileIssue

type LinearState = {
  id: string
  name: string
  type: string
  color?: string
}

type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
}

type DetailComment = {
  id: string | number
  author?: string
  authorAvatarUrl?: string
  user?: { displayName?: string }
  isBot?: boolean
  body: string
  createdAt?: string
  url?: string
  reactions?: Array<{
    content:
      | 'thumbs_up'
      | 'thumbs_down'
      | 'laugh'
      | 'confused'
      | 'heart'
      | 'hooray'
      | 'rocket'
      | 'eyes'
    count: number
  }>
  path?: string
  line?: number
  startLine?: number
  threadId?: string
  isResolved?: boolean
}

type GitHubDetailFile = {
  path: string
  oldPath?: string
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions?: number
  deletions?: number
  isBinary?: boolean
  viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
}

type GitHubDetailCheck = {
  name: string
  status: string
  conclusion?: string | null
  url?: string | null
}

type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
}

type DetailPayload =
  | {
      provider: 'github'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      reviewDecision?: string | null
      reviewRequests: GitHubAssignableUser[]
      latestReviews: GitHubPRReviewSummary[]
      headSha?: string
      baseSha?: string
      pullRequestId?: string
      checks: GitHubDetailCheck[]
      files: GitHubDetailFile[]
    }
  | {
      provider: 'gitlab'
      body: string
      comments: DetailComment[]
      labels: string[]
      assignees: string[]
      pipelineJobs: Array<{
        id?: number
        name: string
        stage: string
        status: string
        webUrl?: string | null
        duration?: number | null
      }>
    }
  | {
      provider: 'linear'
      description: string
      comments: DetailComment[]
      labels: string[]
      assignee?: string
      project?: LinearProject
      children: LinearIssueChild[]
    }

type GitHubTaskKind = 'issues' | 'prs'
type GitHubMode = GitHubTaskKind | 'project'
type GitHubPreset = 'issues' | 'my-issues' | 'prs' | 'my-prs' | 'review'
type GitLabView = 'project' | 'todos'
type GitLabFilter = 'opened' | 'merged' | 'closed' | 'all'
type LinearFilter = 'assigned' | 'created' | 'all' | 'completed'
type LinearViewMode = 'list' | 'board'
type LinearGroupBy = 'none' | 'status' | 'assignee' | 'priority' | 'team'
type LinearOrderBy = 'priority' | 'updated' | 'identifier'
type LinearDisplayProperty = 'state' | 'priority' | 'assignee' | 'team' | 'labels' | 'updated'
type TaskSort = 'updated' | 'repository'
type DetailCommentGroup =
  | { kind: 'standalone'; comment: DetailComment }
  | { kind: 'thread'; threadId: string; root: DetailComment; replies: DetailComment[] }
type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: GitHubPreset | 'all' | null
  githubItemsQuery?: string
  githubProjectHiddenFieldIdsByView?: Record<string, string[]>
  linearPreset?: LinearFilter
  linearQuery?: string
}
type RuntimeTaskSettings = {
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

type LinearWorkspace = {
  id: string
  organizationName?: string
  displayName?: string
}

type LinearStatusResponse = {
  connected?: boolean
  workspaces?: LinearWorkspace[]
  selectedWorkspaceId?: string | 'all' | null
  activeWorkspaceId?: string | null
}

type GitHubProjectOwnerType = 'organization' | 'user'
type GitHubProjectRef = {
  owner: string
  ownerType: GitHubProjectOwnerType
  number: number
}
type GitHubProjectSettings = {
  pinned: GitHubProjectRef[]
  recent: Array<GitHubProjectRef & { lastOpenedAt: string }>
  lastViewByProject: Record<string, { viewId: string }>
  activeProject: GitHubProjectRef | null
}
type GitHubProjectSummary = GitHubProjectRef & {
  id: string
  title: string
  url: string
  source: string
}
type GitHubProjectPartialFailure = {
  owner: string
  message: string
}
type GitHubProjectViewSummary = {
  id: string
  number: number
  name: string
  layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
}
type GitHubIssueType = {
  id: string
  name: string
  color: string | null
  description: string | null
}
type GitHubProjectField =
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
type GitHubProjectSort = {
  direction: GitHubProjectSortDirection
  field: GitHubProjectField
}
type GitHubProjectFieldValue =
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
type GitHubProjectFieldMutationValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'date'; date: string }
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }
type GitHubProjectRow = {
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
type GitHubProjectTable = {
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

type TaskItem =
  | {
      key: string
      provider: 'github'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitHubWorkItem
    }
  | {
      key: string
      provider: 'gitlab'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabWorkItem
    }
  | {
      key: string
      provider: 'gitlabTodo'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabTodo
    }
  | {
      key: string
      provider: 'linear'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: LinearIssue
    }

type ActionableTaskItem = Exclude<TaskItem, { provider: 'gitlabTodo' }>
type HostedReviewMergeMethod = 'merge' | 'squash' | 'rebase'
type HostedReviewItem =
  | Extract<TaskItem, { provider: 'github' }>
  | Extract<TaskItem, { provider: 'gitlab' }>
type PendingHostedMerge = {
  item: HostedReviewItem
  method: HostedReviewMergeMethod
}
type PendingProjectGitHubMerge = {
  row: GitHubProjectRow
  method: HostedReviewMergeMethod
}
type PendingHostedStateChange =
  | {
      source: 'task'
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
      nextState: 'open' | 'opened' | 'closed'
    }
  | {
      source: 'project'
      row: GitHubProjectRow
      nextState: 'open' | 'closed'
    }

type SetupPrompt = {
  item: ActionableTaskItem
  repoIdOverride?: string
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
  repoName: string
  command: string
  source: string | null
}

type WorkspaceCreateArgs = {
  item: ActionableTaskItem
  repoIdOverride?: string
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  agentOverride?: WorkspaceAgentChoice
  workspaceNameOverride?: string
  noteOverride?: string
  baseBranchOverride?: string
  branchNameOverride?: string
  sparseCheckoutOverride?: { directories: string[]; presetId?: string }
}

type OrcaYamlTrustPrompt = WorkspaceCreateArgs & {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

type WorkspaceCreateDraft = {
  item: ActionableTaskItem
  repoIdOverride?: string
}

type WorkspaceSparseDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

function sortSparsePresetsByName(presets: SparsePreset[]): SparsePreset[] {
  return [...presets].sort((left, right) => left.name.localeCompare(right.name))
}

function workspaceAgentIconId(agent: WorkspaceAgentChoice): string {
  return agent === 'blank' ? '__blank__' : agent
}

type ProjectRepoNotInOrcaPrompt = {
  owner: string
  repo: string
  url: string | null
}

type TaskListEntry =
  | { type: 'section'; key: string; label: string; color: string }
  | { type: 'item'; key: string; item: TaskItem }

const PROVIDER_OPTIONS: PickerOption<TaskProvider>[] = [
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

const GITLAB_FILTER_OPTIONS: PickerOption<GitLabFilter>[] = [
  { value: 'opened', label: 'Open', subtitle: 'Open issues and merge requests' },
  { value: 'merged', label: 'Merged', subtitle: 'Merged merge requests' },
  { value: 'closed', label: 'Closed', subtitle: 'Closed issues and merge requests' },
  { value: 'all', label: 'All', subtitle: 'Any GitLab state' }
]

const LINEAR_FILTER_OPTIONS: PickerOption<LinearFilter>[] = [
  { value: 'all', label: 'All', subtitle: 'Open issues across connected workspaces' },
  { value: 'assigned', label: 'My Issues', subtitle: 'Issues assigned to you' },
  { value: 'created', label: 'Created', subtitle: 'Issues created by you' },
  { value: 'completed', label: 'Completed', subtitle: 'Recently completed issues' }
]

const LINEAR_VIEW_OPTIONS: PickerOption<LinearViewMode>[] = [
  { value: 'list', label: 'List', subtitle: 'Compact issue rows' },
  { value: 'board', label: 'Board', subtitle: 'Grouped columns' }
]

function taskWorkspaceFallback(item: ActionableTaskItem): string {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    return `${item.source.type}-${item.source.number}`
  }
  return item.source.identifier.toLowerCase()
}

function taskWorkspaceSuggestedName(item: ActionableTaskItem): string {
  return getLinkedWorkItemSuggestedName(item) || taskWorkspaceFallback(item)
}

const COMMENT_REACTION_EMOJI: Record<
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

const LINEAR_GROUP_OPTIONS: PickerOption<LinearGroupBy>[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Status' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'priority', label: 'Priority' },
  { value: 'team', label: 'Team' }
]

const LINEAR_ORDER_OPTIONS: PickerOption<LinearOrderBy>[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Updated' },
  { value: 'identifier', label: 'Identifier' }
]

const LINEAR_DISPLAY_OPTIONS: PickerOption<LinearDisplayProperty>[] = [
  { value: 'state', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'team', label: 'Team' },
  { value: 'labels', label: 'Labels' },
  { value: 'updated', label: 'Updated' }
]

const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

const GITHUB_KIND_OPTIONS: PickerOption<GitHubMode>[] = [
  { value: 'issues', label: 'Issues', subtitle: 'GitHub issues' },
  { value: 'prs', label: 'PRs', subtitle: 'GitHub pull requests' },
  { value: 'project', label: 'Projects', subtitle: 'GitHub Projects views' }
]

const ISSUE_PRESETS: PickerOption<GitHubPreset>[] = [
  { value: 'issues', label: 'Open', subtitle: 'Open GitHub issues' },
  { value: 'my-issues', label: 'Assigned to me', subtitle: 'Open issues assigned to you' }
]

const PR_PRESETS: PickerOption<GitHubPreset>[] = [
  { value: 'prs', label: 'Open', subtitle: 'Open pull requests' },
  { value: 'my-prs', label: 'Mine', subtitle: 'Pull requests authored by you' },
  { value: 'review', label: 'Needs review', subtitle: 'Review requests assigned to you' }
]

const GITLAB_VIEW_OPTIONS: PickerOption<GitLabView>[] = [
  { value: 'project', label: 'Project MRs', subtitle: 'Merge requests and issues by repository' },
  { value: 'todos', label: 'My Todos', subtitle: 'Pending GitLab todos' }
]

const SORT_OPTIONS: PickerOption<TaskSort>[] = [
  { value: 'updated', label: 'Updated', subtitle: 'Newest activity first' },
  {
    value: 'repository',
    label: 'Repository',
    subtitle: 'Group by repository, then newest activity'
  }
]

type ProjectSortOverride = { fieldId: string; direction: GitHubProjectSortDirection }
type ProjectListEntry =
  | { type: 'group'; group: ProjectGroup; collapsed: boolean }
  | { type: 'row'; row: GitHubProjectRow }
type LinearIssueSection = { key: string; label: string; color: string; issues: LinearIssue[] }
type LinearListEntry =
  | { type: 'section'; section: LinearIssueSection }
  | { type: 'issue'; issue: LinearIssue }

const PROJECT_VIEW_DEFAULT_SORT = '__view_default__'
const GITHUB_REPO_CONCURRENCY = 3
const MAX_RENDERED_PR_DIFF_LINES = 400
const GITLAB_PER_PAGE = 50
const LINEAR_LIMIT = 50
const MOBILE_TASKS_CAPABILITY = 'mobile.tasks.v1'
// Why: task detail drawers can launch child sheets; children must layer above
// the still-mounted parent while its dismissal animation/state remains alive.
const TASK_SECONDARY_DRAWER_Z_INDEX = 1100
// Why: the mobile detail drawer should support quick triage and core actions.
// Desktop keeps the broad metadata editing surface for dense issue/PR work.
const SHOW_MOBILE_DETAIL_LABEL_CHIPS = false
const SHOW_MOBILE_DETAIL_METADATA_EDITORS = false
const SHOW_MOBILE_DETAIL_REVIEW_PANELS = false
const SHOW_MOBILE_LINEAR_DETAIL_TOOLS = false
const SHOW_MOBILE_COMMENT_THREAD_TOOLS = false
const SHOW_MOBILE_PROJECT_METADATA_EDITORS = false
const SHOW_MOBILE_PROJECT_REVIEW_PANELS = false
const EMPTY_GITHUB_PROJECT_SETTINGS: GitHubProjectSettings = {
  pinned: [],
  recent: [],
  lastViewByProject: {},
  activeProject: null
}

function isSuccess(response: unknown): response is RpcSuccess {
  return Boolean(response && typeof response === 'object' && (response as RpcSuccess).ok)
}

function taskTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function formatUpdatedAt(value: string): string {
  const time = taskTime(value)
  if (!time) {
    return ''
  }
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

function getTaskPresetQuery(preset: GitHubPreset): string {
  switch (preset) {
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'issues':
    default:
      return 'is:issue is:open'
  }
}

function isTaskProvider(value: unknown): value is TaskProvider {
  return value === 'github' || value === 'gitlab' || value === 'linear'
}

function normalizeGitHubPreset(value: unknown): GitHubPreset {
  return value === 'my-issues' ||
    value === 'prs' ||
    value === 'my-prs' ||
    value === 'review' ||
    value === 'issues'
    ? value
    : 'issues'
}

function normalizeLinearFilter(value: unknown): LinearFilter {
  return value === 'assigned' || value === 'created' || value === 'completed' || value === 'all'
    ? value
    : 'all'
}

function githubKindFromQuery(query: string, fallbackPreset: GitHubPreset): GitHubTaskKind {
  if (/\bis:pr\b/i.test(query)) {
    return 'prs'
  }
  if (/\bis:issue\b/i.test(query)) {
    return 'issues'
  }
  return fallbackPreset === 'prs' || fallbackPreset === 'my-prs' || fallbackPreset === 'review'
    ? 'prs'
    : 'issues'
}

function githubProjectKey(project: GitHubProjectRef): string {
  return `${project.ownerType}:${project.owner}:${project.number}`
}

function parseProjectInput(
  input: string
): { owner: string; number: number; viewNumber?: number } | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const short = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/.exec(trimmed)
  if (short) {
    return { owner: short[1]!, number: Number(short[2]) }
  }
  try {
    const url = new URL(trimmed)
    if (url.hostname !== 'github.com') {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if ((parts[0] === 'orgs' || parts[0] === 'users') && parts[2] === 'projects' && parts[3]) {
      const number = Number(parts[3])
      if (!Number.isInteger(number) || number < 1) {
        return null
      }
      const viewNumber =
        parts[4] === 'views' && parts[5] && Number.isInteger(Number(parts[5]))
          ? Number(parts[5])
          : undefined
      return {
        owner: parts[1]!,
        number,
        ...(viewNumber && viewNumber > 0 ? { viewNumber } : {})
      }
    }
  } catch {
    return null
  }
  return null
}

function projectRowType(row: GitHubProjectRow): 'issue' | 'pr' | null {
  if (row.itemType === 'ISSUE') {
    return 'issue'
  }
  if (row.itemType === 'PULL_REQUEST') {
    return 'pr'
  }
  return null
}

function canCreateWorkspaceFromProjectRow(row: GitHubProjectRow): boolean {
  // Why: desktop only exposes Project "Start work" for backed issue/PR rows
  // with enough GitHub identity to build the linked work item.
  return projectRowType(row) !== null && row.content.number != null && Boolean(row.content.url)
}

function splitRepositorySlug(slug: string | null): { owner: string; repo: string } | null {
  const [owner, repo] = slug?.split('/') ?? []
  return owner && repo ? { owner, repo } : null
}

const GITHUB_PROJECT_OPTION_COLORS: Record<string, string> = {
  GRAY: '#8b949e',
  RED: '#f85149',
  ORANGE: '#db6d28',
  YELLOW: '#d29922',
  GREEN: '#3fb950',
  BLUE: '#58a6ff',
  PURPLE: '#bc8cff',
  PINK: '#db61a2'
}

function githubProjectOptionColor(color: string | null | undefined): string {
  if (!color) {
    return colors.textMuted
  }
  const upper = color.toUpperCase()
  const mapped = GITHUB_PROJECT_OPTION_COLORS[upper]
  if (mapped) {
    return mapped
  }
  const hex = color.startsWith('#') ? color : `#${color}`
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : colors.textMuted
}

function projectRowStatusLabel(row: GitHubProjectRow): string {
  if (row.itemType === 'DRAFT_ISSUE') {
    return 'Draft'
  }
  if (row.itemType === 'REDACTED') {
    return 'Redacted'
  }
  if (row.content.isDraft) {
    return 'Draft'
  }
  if (row.content.state === 'MERGED') {
    return 'Merged'
  }
  if (row.content.state === 'CLOSED') {
    return 'Closed'
  }
  return 'Open'
}

function scopeGitHubTaskSearch(query: string, kind: GitHubTaskKind): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return getTaskPresetQuery(kind === 'prs' ? 'prs' : 'issues')
  }
  if (/\bis:(?:issue|pr)\b/i.test(trimmed)) {
    return trimmed
  }
  return `${kind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}

function gitHubStatusLabel(item: GitHubWorkItem): string {
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

function gitHubTaskSubtitle(item: GitHubWorkItem): string {
  return `${item.repoName} ${item.type === 'pr' ? '#' : '#'}${item.number}`
}

function createGitHubTask(repo: RepoSummary, item: Omit<GitHubWorkItem, 'repoId' | 'repoName'>) {
  const source: GitHubWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `github:${repo.id}:${item.type}:${item.number}`,
    provider: 'github' as const,
    title: item.title,
    subtitle: gitHubTaskSubtitle(source),
    status: gitHubStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

function gitLabStatusLabel(item: GitLabWorkItem): string {
  if (item.state === 'opened') {
    return 'Open'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Locked'
}

function createGitLabTask(repo: RepoSummary, item: Omit<GitLabWorkItem, 'repoId' | 'repoName'>) {
  const source: GitLabWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `gitlab:${repo.id}:${item.type}:${item.number}`,
    provider: 'gitlab' as const,
    title: item.title,
    subtitle: `${repo.displayName} ${item.type === 'mr' ? '!' : '#'}${item.number}`,
    status: gitLabStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

function gitLabTodoTargetLabel(todo: Pick<GitLabTodo, 'targetType'>): string {
  if (todo.targetType === 'MergeRequest') {
    return 'Merge request'
  }
  if (todo.targetType === 'Issue') {
    return 'Issue'
  }
  return 'GitLab todo'
}

function gitLabTodoTargetRef(todo: Pick<GitLabTodo, 'targetType' | 'targetIid'>): string {
  if (!todo.targetIid) {
    return ''
  }
  if (todo.targetType === 'MergeRequest') {
    return `!${todo.targetIid}`
  }
  if (todo.targetType === 'Issue') {
    return `#${todo.targetIid}`
  }
  return String(todo.targetIid)
}

function createGitLabTodoTask(todo: GitLabTodo): TaskItem {
  const targetRef = gitLabTodoTargetRef(todo)
  return {
    key: `gitlab-todo:${todo.id}`,
    provider: 'gitlabTodo',
    title: todo.targetTitle || todo.targetUrl,
    subtitle: `${todo.projectPath}${targetRef ? ` ${targetRef}` : ''}`,
    status: todo.actionName.replace(/_/g, ' ') || 'Todo',
    updatedAt: todo.updatedAt,
    source: todo
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

function isHostedTaskRepo(repo: RepoSummary): boolean {
  return repo.kind !== 'folder'
}

function reconcileRepoSelection(
  repos: RepoSummary[],
  persisted: string[] | null | undefined
): Set<string> {
  if (!persisted || persisted.length === 0) {
    return new Set()
  }
  const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
  const selected = persisted.filter((id) => availableIds.has(id))
  return selected.length === 0 ? new Set() : new Set(selected)
}

function createLinearTask(issue: LinearIssue): TaskItem {
  return {
    key: `linear:${issue.workspaceId ?? 'workspace'}:${issue.id}`,
    provider: 'linear',
    title: issue.title,
    subtitle: `${issue.identifier} · ${issue.team.name}`,
    status: issue.state.name,
    updatedAt: issue.updatedAt,
    source: issue
  }
}

const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

function getLinearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}

function formatGitHubReviewState(state: string | null | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes requested'
    case 'COMMENTED':
      return 'Commented'
    case 'DISMISSED':
      return 'Dismissed'
    case 'PENDING':
      return 'Pending'
    default:
      return 'Reviewed'
  }
}

function getGitHubReviewerRows(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): GitHubPRReviewerRow[] {
  const byLogin = new Map<string, GitHubPRReviewerRow>()
  for (const user of item.reviewRequests ?? []) {
    const login = user.login.trim()
    if (!login) {
      continue
    }
    byLogin.set(login.toLowerCase(), {
      login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      stateLabel: 'Requested'
    })
  }
  for (const review of item.latestReviews ?? []) {
    const login = review.login.trim()
    const key = login.toLowerCase()
    if (!login || byLogin.has(key)) {
      continue
    }
    byLogin.set(key, {
      login,
      name: null,
      avatarUrl: review.avatarUrl,
      stateLabel: formatGitHubReviewState(review.state)
    })
  }
  return Array.from(byLogin.values())
}

function getGitHubReviewSummary(item: {
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): string {
  if (item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  const rows = getGitHubReviewerRows(item)
  if (rows.length === 0) {
    return 'No reviewers'
  }
  if (rows.length === 1) {
    return `${rows[0]!.login} - ${rows[0]!.stateLabel}`
  }
  return `${rows[0]!.login} +${rows.length - 1}`
}

function formatGitHubPRDelta(item: GitHubWorkItem): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(`${item.changedFiles} ${item.changedFiles === 1 ? 'file' : 'files'}`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

function hostedBranchSummary(item: TaskItem): { head: string; base: string } | null {
  if (item.provider === 'github' && item.source.type === 'pr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  if (item.provider === 'gitlab' && item.source.type === 'mr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  return null
}

function getGitHubChecksLabel(item: GitHubWorkItem): string {
  const summary = item.checksSummary
  if (!summary) {
    return 'Checks'
  }
  if (summary.total === 0) {
    return 'No checks'
  }
  if (summary.failed > 0) {
    return `${summary.failed} failing`
  }
  if (summary.pending > 0) {
    return `${summary.pending} pending`
  }
  return `${summary.passed}/${summary.total} passed`
}

function getGitHubMergeLabel(item: GitHubWorkItem): string {
  if (item.mergeable === undefined && item.mergeStateStatus === undefined) {
    return 'Merge'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'closed') {
    return 'Closed'
  }
  if (item.mergeable === 'CONFLICTING') {
    return 'Conflicts'
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return 'Behind'
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return 'Blocked'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'Able to merge'
  }
  return 'Unknown'
}

function getHostedReviewMergeMethodLabel(method: HostedReviewMergeMethod): string {
  if (method === 'squash') {
    return 'Squash and merge'
  }
  if (method === 'rebase') {
    return 'Rebase and merge'
  }
  return 'Create merge commit'
}

function hostedReviewMergeTargetLabel(item: HostedReviewItem): string {
  return item.provider === 'gitlab' ? 'merge request' : 'PR'
}

function getHostedMergeConfirmMessage(pending: PendingHostedMerge): string {
  const target = hostedReviewMergeTargetLabel(pending.item)
  if (pending.method === 'squash') {
    return `Squash and merge ${target} #${pending.item.source.number}?`
  }
  const action = pending.method === 'rebase' ? 'Rebase and merge' : 'Merge'
  return `${action} ${target} #${pending.item.source.number}?`
}

function getProjectGitHubMergeConfirmMessage(pending: PendingProjectGitHubMerge): string {
  const number = pending.row.content.number
  if (pending.method === 'squash') {
    return `Squash and merge PR #${number}?`
  }
  const action = pending.method === 'rebase' ? 'Rebase and merge' : 'Merge'
  return `${action} PR #${number}?`
}

function hostedStateChangeAction(nextState: PendingHostedStateChange['nextState']): string {
  return nextState === 'closed' ? 'Close' : 'Reopen'
}

function hostedStateChangeTarget(pending: PendingHostedStateChange): {
  titleTarget: string
  labelTarget: string
  number: number | null
} {
  if (pending.source === 'project') {
    const type = projectRowType(pending.row)
    return {
      titleTarget: type === 'pr' ? 'Pull Request' : 'Issue',
      labelTarget: type === 'pr' ? 'PR' : 'Issue',
      number: pending.row.content.number
    }
  }
  if (pending.item.provider === 'gitlab') {
    return {
      titleTarget: pending.item.source.type === 'mr' ? 'Merge Request' : 'Issue',
      labelTarget: pending.item.source.type === 'mr' ? 'MR' : 'Issue',
      number: pending.item.source.number
    }
  }
  return {
    titleTarget: pending.item.source.type === 'pr' ? 'Pull Request' : 'Issue',
    labelTarget: pending.item.source.type === 'pr' ? 'PR' : 'Issue',
    number: pending.item.source.number
  }
}

function getHostedStateConfirmTitle(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.titleTarget}`
}

function getHostedStateConfirmMessage(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget} #${target.number}?`
}

function getHostedStateConfirmLabel(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget}`
}

function getGitHubPRSignalTone(
  item: GitHubWorkItem,
  signal: 'review' | 'checks' | 'merge'
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (signal === 'review') {
    if (item.reviewDecision === 'APPROVED') {
      return 'success'
    }
    if (item.reviewDecision === 'CHANGES_REQUESTED') {
      return 'danger'
    }
    if (item.reviewRequests && item.reviewRequests.length > 0) {
      return 'warning'
    }
    return 'neutral'
  }
  if (signal === 'checks') {
    if (item.checksSummary?.state === 'success') {
      return 'success'
    }
    if (item.checksSummary?.state === 'failure') {
      return 'danger'
    }
    if (item.checksSummary?.state === 'pending') {
      return 'warning'
    }
    return 'neutral'
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'BLOCKED') {
    return 'danger'
  }
  if (item.mergeStateStatus === 'BEHIND' || item.checksSummary?.state === 'pending') {
    return 'warning'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'success'
  }
  return 'neutral'
}

function mergeGitHubAssignableUsers(
  users: GitHubAssignableUser[],
  seeds: GitHubAssignableUser[]
): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of [...users, ...seeds]) {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      continue
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  return [...byLogin.values()]
}

function getGitHubReviewerSeedUsers(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  author?: string | null
}): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  const add = (user: GitHubAssignableUser): void => {
    const login = user.login.trim()
    if (!login || byLogin.has(login.toLowerCase())) {
      return
    }
    byLogin.set(login.toLowerCase(), { ...user, login })
  }
  for (const user of item.reviewRequests ?? []) {
    add(user)
  }
  for (const review of item.latestReviews ?? []) {
    add({
      login: review.login,
      name: null,
      avatarUrl: review.avatarUrl ?? null
    })
  }
  if (item.author) {
    add({ login: item.author, name: null, avatarUrl: null })
  }
  return [...byLogin.values()]
}

function sameGitHubOwnerRepo(
  a: GitHubOwnerRepo | null | undefined,
  b: GitHubOwnerRepo | null | undefined
): boolean {
  return (
    !!a &&
    !!b &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

function hasGitHubIssueSourceChoice(sources: GitHubRepoSources | undefined): boolean {
  return Boolean(
    sources?.prs &&
    sources.upstreamCandidate &&
    !sameGitHubOwnerRepo(sources.prs, sources.upstreamCandidate)
  )
}

function issueSourceSlug(source: GitHubOwnerRepo | null | undefined): string {
  return source ? `${source.owner}/${source.repo}` : 'Unknown'
}

function compareLinearIssues(a: LinearIssue, b: LinearIssue, orderBy: LinearOrderBy): number {
  if (orderBy === 'updated') {
    return taskTime(b.updatedAt) - taskTime(a.updatedAt)
  }
  if (orderBy === 'identifier') {
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  }
  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  return priorityDelta || taskTime(b.updatedAt) - taskTime(a.updatedAt)
}

function getLinearIssueGroup(
  issue: LinearIssue,
  groupBy: LinearGroupBy
): {
  key: string
  label: string
  color: string
} {
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

function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearIssueSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'Issues', color: colors.accentBlue, issues: sorted }]
  }
  const sections = new Map<
    string,
    { key: string; label: string; color: string; issues: LinearIssue[] }
  >()
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

function linearIssueSecondaryParts(
  issue: LinearIssue,
  displayProperties: ReadonlySet<LinearDisplayProperty>
): string[] {
  const parts = [issue.identifier]
  if (displayProperties.has('priority')) {
    parts.push(getLinearPriorityLabel(issue.priority))
  }
  if (displayProperties.has('assignee') && issue.assignee?.displayName) {
    parts.push(issue.assignee.displayName)
  }
  if (displayProperties.has('team')) {
    parts.push(issue.team.name)
  }
  if (displayProperties.has('labels') && issue.labels.length > 0) {
    parts.push(issue.labels.slice(0, 2).join(', '))
  }
  if (displayProperties.has('updated')) {
    parts.push(formatUpdatedAt(issue.updatedAt))
  }
  return parts
}

function reconcileTeamSelection(
  teams: LinearTeam[],
  saved: string[] | null | undefined
): Set<string> {
  if (!saved) {
    return new Set(teams.map((team) => team.id))
  }
  const available = new Set(teams.map((team) => team.id))
  const next = new Set(saved.filter((id) => available.has(id)))
  return next.size === 0 ? new Set(teams.map((team) => team.id)) : next
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function splitReviewerList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function editableProjectFields(table: GitHubProjectTable | null): GitHubProjectField[] {
  return (
    table?.selectedView.fields?.filter((field) =>
      ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION'].includes(field.dataType)
    ) ?? []
  )
}

function projectFieldValueLabel(row: GitHubProjectRow, field: GitHubProjectField): string {
  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return 'Empty'
  }
  if (value.kind === 'single-select') {
    return value.name
  }
  if (value.kind === 'iteration') {
    return value.title
  }
  if (value.kind === 'text') {
    return value.text || 'Empty'
  }
  if (value.kind === 'number') {
    return String(value.number)
  }
  if (value.kind === 'date') {
    return value.date
  }
  if (value.kind === 'labels') {
    return value.labels.map((label) => label.name).join(', ') || 'Empty'
  }
  if (value.kind === 'users') {
    return value.users.map((user) => user.login).join(', ') || 'Empty'
  }
  return 'Empty'
}

function projectFieldDisplayLabel(row: GitHubProjectRow, field: GitHubProjectField): string {
  if (field.dataType === 'ASSIGNEES') {
    return row.content.assignees.map((user) => user.login).join(', ') || 'Empty'
  }
  if (field.dataType === 'LABELS') {
    return row.content.labels.map((label) => label.name).join(', ') || 'Empty'
  }
  if (field.dataType === 'REPOSITORY') {
    return row.content.repository ?? 'Empty'
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return row.content.parentIssue ? `#${row.content.parentIssue.number}` : 'Empty'
  }
  if (field.dataType === 'ISSUE_TYPE') {
    return row.content.issueType?.name ?? 'Empty'
  }
  if (field.dataType === 'TITLE') {
    return row.content.title
  }
  return projectFieldValueLabel(row, field)
}

function projectSummaryFields(table: GitHubProjectTable | null): GitHubProjectField[] {
  return (
    table?.selectedView.fields?.filter(
      (field) => field.dataType !== 'TITLE' && field.dataType !== 'REPOSITORY'
    ) ?? []
  )
}

function projectFieldVisibilityKey(table: GitHubProjectTable | null): string | null {
  if (!table) {
    return null
  }
  // Why: desktop scopes column visibility to project + view; matching that
  // avoids hiding fields across unrelated Project views with colliding IDs.
  return `${table.project.id}:${table.selectedView.id}`
}

function projectFieldDraftValue(row: GitHubProjectRow, field: GitHubProjectField): string {
  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return ''
  }
  if (value.kind === 'text') {
    return value.text
  }
  if (value.kind === 'number') {
    return String(value.number)
  }
  if (value.kind === 'date') {
    return value.date
  }
  return ''
}

function normalizeProjectTableForMobileSort(
  table: GitHubProjectTable,
  rows: GitHubProjectRow[],
  sortOverride: ProjectSortOverride | null
): SharedGitHubProjectTable {
  const fields = table.selectedView.fields ?? []
  const overrideField = sortOverride
    ? fields.find((field) => field.id === sortOverride.fieldId)
    : undefined
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    content: {
      ...row.content,
      stateReason: row.content.stateReason ?? null,
      parentIssue: row.content.parentIssue ?? null,
      issueType: row.content.issueType ?? null
    },
    fieldValuesByFieldId: row.fieldValuesByFieldId ?? {},
    position: row.position ?? index
  }))

  return {
    ...table,
    selectedView: {
      ...table.selectedView,
      fields,
      groupByFields: table.selectedView.groupByFields ?? [],
      sortByFields:
        sortOverride && overrideField
          ? [{ field: overrideField, direction: sortOverride.direction }]
          : (table.selectedView.sortByFields ?? [])
    },
    rows: normalizedRows,
    parentFieldDropped: table.parentFieldDropped === true
  } as unknown as SharedGitHubProjectTable
}

function projectGroupMeta(group: ProjectGroup): string {
  const parts = [`${group.rows.length}`]
  if (group.iteration) {
    const endDate = new Date(`${group.iteration.startDate}T00:00:00Z`)
    if (!Number.isNaN(endDate.getTime())) {
      endDate.setUTCDate(endDate.getUTCDate() + group.iteration.duration - 1)
      parts.push(`${group.iteration.startDate} - ${endDate.toISOString().slice(0, 10)}`)
    }
    if (isIterationCurrent(group.iteration)) {
      parts.push('Current')
    }
  }
  return parts.join(' · ')
}

function optimisticProjectFieldValue(
  field: GitHubProjectField,
  value: GitHubProjectFieldMutationValue
): GitHubProjectFieldValue {
  if (value.kind === 'single-select' && field.kind === 'single-select') {
    const option = field.options.find((entry) => entry.id === value.optionId)
    return {
      kind: 'single-select',
      fieldId: field.id,
      optionId: value.optionId,
      name: option?.name ?? 'Selected',
      color: option?.color ?? 'GRAY'
    }
  }
  if (value.kind === 'iteration' && field.kind === 'iteration') {
    const iteration = field.iterations.find((entry) => entry.id === value.iterationId)
    return {
      kind: 'iteration',
      fieldId: field.id,
      iterationId: value.iterationId,
      title: iteration?.title ?? 'Iteration',
      startDate: iteration?.startDate ?? '',
      duration: iteration?.duration ?? 0
    }
  }
  if (value.kind === 'number') {
    return { kind: 'number', fieldId: field.id, number: value.number }
  }
  if (value.kind === 'date') {
    return { kind: 'date', fieldId: field.id, date: value.date }
  }
  return { kind: 'text', fieldId: field.id, text: value.kind === 'text' ? value.text : '' }
}

function taskKindLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return item.source.type === 'pr' ? 'Pull request' : 'Issue'
  }
  if (item.provider === 'gitlab') {
    return item.source.type === 'mr' ? 'Merge request' : 'Issue'
  }
  if (item.provider === 'gitlabTodo') {
    return `${gitLabTodoTargetLabel(item.source)} todo`
  }
  return 'Linear ticket'
}

function taskExternalOpenLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return 'Open in GitHub'
  }
  if (item.provider === 'gitlab' || item.provider === 'gitlabTodo') {
    return 'Open in GitLab'
  }
  return 'Open in Linear'
}

function taskStatusActionLabel(item: TaskItem): string {
  const verb =
    item.provider === 'github' || item.provider === 'gitlab'
      ? item.source.state === 'closed'
        ? 'Reopen'
        : 'Close'
      : ''
  return verb ? `${verb} ${taskKindLabel(item).toLowerCase()}` : ''
}

function isGitHubPrMergeBlocked(item: Extract<TaskItem, { provider: 'github' }>): boolean {
  return item.source.type === 'pr' && item.source.mergeable === 'CONFLICTING'
}

function commentAuthor(comment: DetailComment): string {
  return comment.author ?? comment.user?.displayName ?? 'unknown'
}

function commentDate(value: string | undefined): string {
  if (!value) {
    return ''
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : ''
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ''
  }
  const seconds = Math.max(0, Math.floor(value))
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

function commentSourceLabel(comment: DetailComment): string {
  if (comment.path) {
    const line =
      typeof comment.line === 'number'
        ? typeof comment.startLine === 'number' && comment.startLine !== comment.line
          ? `${comment.startLine}-${comment.line}`
          : String(comment.line)
        : ''
    const location = line ? `${comment.path}:${line}` : comment.path
    return `${comment.isResolved ? 'Resolved review' : 'Review'} · ${location}`
  }
  if (comment.threadId) {
    return comment.isResolved ? 'Resolved review thread' : 'Review thread'
  }
  return 'Top-level comment'
}

function groupDetailComments(comments: DetailComment[]): DetailCommentGroup[] {
  const threads = new Map<string, { root: DetailComment; replies: DetailComment[] }>()
  const groups: DetailCommentGroup[] = []
  const emittedThreads = new Set<string>()

  for (const comment of comments) {
    if (!comment.threadId) {
      continue
    }
    const existing = threads.get(comment.threadId)
    if (existing) {
      existing.replies.push(comment)
    } else {
      threads.set(comment.threadId, { root: comment, replies: [] })
    }
  }

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ kind: 'standalone', comment })
      continue
    }
    if (emittedThreads.has(comment.threadId)) {
      continue
    }
    emittedThreads.add(comment.threadId)
    const thread = threads.get(comment.threadId)
    if (thread) {
      groups.push({ kind: 'thread', threadId: comment.threadId, ...thread })
    }
  }

  return groups
}

function detailCommentGroupId(group: DetailCommentGroup): string {
  return group.kind === 'thread' ? `thread:${group.threadId}` : `comment:${group.comment.id}`
}

function detailCommentGroupRoot(group: DetailCommentGroup): DetailComment {
  return group.kind === 'thread' ? group.root : group.comment
}

function detailCommentGroupCount(group: DetailCommentGroup): number {
  return group.kind === 'thread' ? 1 + group.replies.length : 1
}

function isResolvedDetailCommentGroup(group: DetailCommentGroup): boolean {
  return detailCommentGroupRoot(group).isResolved === true
}

function discussionSummary(count: number): string {
  if (count === 0) {
    return 'No comments yet'
  }
  return `${count} ${count === 1 ? 'comment' : 'comments'}`
}

function renderCommentReactions(comment: DetailComment): ReactNode {
  const reactions = (comment.reactions ?? []).filter((reaction) => reaction.count > 0)
  if (reactions.length === 0) {
    return null
  }
  return (
    <View style={styles.reactionRow}>
      {reactions.map((reaction) => (
        <View key={reaction.content} style={styles.reactionChip}>
          <Text style={styles.reactionText}>
            {COMMENT_REACTION_EMOJI[reaction.content]} {reaction.count}
          </Text>
        </View>
      ))}
    </View>
  )
}

function formatDiffLineNumber(value: number | undefined): string {
  return value === undefined ? '    ' : value.toString().padStart(4, ' ')
}

function diffLinePrefix(kind: GitHubPrFileDiffLine['kind']): string {
  if (kind === 'added') {
    return '+'
  }
  if (kind === 'removed') {
    return '-'
  }
  return ' '
}

function GitHubPrFileDiff({
  filePath,
  contents,
  commentDrafts,
  disabled,
  onCommentDraftChange,
  onSubmitComment
}: {
  filePath: string
  contents: GitHubPRFileContents
  commentDrafts: Record<string, string>
  disabled: boolean
  onCommentDraftChange: (key: string, value: string) => void
  onSubmitComment: (line: number) => void
}): ReactNode {
  const diffPreview = useMemo(
    () =>
      buildGitHubPrFileDiffPreview(
        contents.original,
        contents.modified,
        MAX_RENDERED_PR_DIFF_LINES
      ),
    [contents.modified, contents.original]
  )
  const syntaxLanguage = useMemo(() => resolveMobileSyntaxLanguage(filePath), [filePath])
  const visibleDiffLines = useMemo(
    () => highlightMobileDiffLines(diffPreview.lines, syntaxLanguage),
    [diffPreview.lines, syntaxLanguage]
  )
  const hiddenDiffLineCount = Math.max(0, diffPreview.totalLineCount - visibleDiffLines.length)

  if (diffPreview.totalLineCount === 0) {
    return <Text style={styles.detailMuted}>No text changes found.</Text>
  }

  return (
    <View style={styles.fileDiff}>
      {hiddenDiffLineCount > 0 ? (
        <Text style={styles.detailMuted}>
          Showing first {MAX_RENDERED_PR_DIFF_LINES} of {diffPreview.totalLineCount} diff lines.
        </Text>
      ) : null}
      {visibleDiffLines.map((line) => {
        const commentLine = line.kind === 'removed' ? undefined : line.newLineNumber
        const draftKey = commentLine === undefined ? '' : `${filePath}:${commentLine}`
        return (
          <View
            key={line.key}
            style={[
              styles.diffLineBlock,
              line.kind === 'added'
                ? styles.diffLineAdded
                : line.kind === 'removed'
                  ? styles.diffLineRemoved
                  : null
            ]}
          >
            <View style={styles.diffCodeRow}>
              <Text style={styles.diffLineNumbers}>
                {formatDiffLineNumber(line.oldLineNumber)}{' '}
                {formatDiffLineNumber(line.newLineNumber)}
              </Text>
              <Text
                style={[
                  styles.codeLine,
                  line.kind === 'added'
                    ? styles.diffCodeAdded
                    : line.kind === 'removed'
                      ? styles.diffCodeRemoved
                      : null
                ]}
              >
                <Text>{diffLinePrefix(line.kind)} </Text>
                <MobileSyntaxSegments segments={line.segments} />
                {line.text ? null : ' '}
              </Text>
            </View>
            {commentLine !== undefined ? (
              <>
                <TextInput
                  style={[styles.input, styles.replyInput]}
                  value={commentDrafts[draftKey] ?? ''}
                  onChangeText={(next) => onCommentDraftChange(draftKey, next)}
                  placeholder="Add review comment"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  style={styles.inlineSaveButtonCompact}
                  disabled={disabled || !(commentDrafts[draftKey] ?? '').trim()}
                  onPress={() => onSubmitComment(commentLine)}
                >
                  <Text style={styles.inlineSaveText}>Comment on line {commentLine}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

function isFailedGitHubCheck(check: { conclusion?: string | null }): boolean {
  return ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
}

function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

function buildPartialRepositoryNotice(failedCount: number, totalCount: number): string {
  return `${failedCount} of ${repositoryCount(totalCount)} failed to load.`
}

function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]!
}

function getRepoBadgeColor(repo: RepoSummary | undefined, fallbackName: string): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? fallbackName)
}

function setupSourceLabel(source: string | null): string {
  if (source === 'orca.yaml') {
    return 'orca.yaml'
  }
  if (source === 'legacy') {
    return 'local hooks'
  }
  return 'repository hooks'
}

function taskRepositoryMeta(
  item: TaskItem,
  reposById: Map<string, RepoSummary>
): { key: string; label: string; color: string } {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    const repo = reposById.get(item.source.repoId)
    return {
      key: item.source.repoId,
      label: repo?.displayName ?? item.source.repoName,
      color: getRepoBadgeColor(repo, item.source.repoName)
    }
  }
  if (item.provider === 'gitlabTodo') {
    return {
      key: item.source.projectPath,
      label: item.source.projectPath,
      color: repoColor(item.source.projectPath)
    }
  }
  return {
    key: item.source.team.id,
    label: item.source.team.name,
    color: item.source.state.color || colors.accentBlue
  }
}

function compareTasksByUpdated(a: TaskItem, b: TaskItem): number {
  return taskTime(b.updatedAt) - taskTime(a.updatedAt)
}

function compareTasksByRepository(
  a: TaskItem,
  b: TaskItem,
  reposById: Map<string, RepoSummary>
): number {
  const aRepo = taskRepositoryMeta(a, reposById)
  const bRepo = taskRepositoryMeta(b, reposById)
  const repoComparison = aRepo.label.localeCompare(bRepo.label, undefined, { sensitivity: 'base' })
  return repoComparison || compareTasksByUpdated(a, b)
}

export default function MobileTasksScreen() {
  const { hostId, taskSource } = useLocalSearchParams<{ hostId: string; taskSource?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const clientRef = useRef<RpcClient | null>(null)
  const reposRef = useRef<RepoSummary[]>([])
  const loadGenerationRef = useRef(0)
  const taskResumeRef = useRef<TaskResumeState>({})
  const [repos, setRepos] = useState<RepoSummary[]>([])
  const [provider, setProvider] = useState<TaskProvider>('github')
  const [visibleProviders, setVisibleProviders] = useState<TaskProvider[]>(() =>
    normalizeVisibleTaskProviders(undefined)
  )
  const [linearConnected, setLinearConnected] = useState(false)
  const [githubMode, setGithubMode] = useState<'items' | 'project'>('items')
  const [githubKind, setGithubKind] = useState<GitHubTaskKind>('issues')
  const [githubPreset, setGithubPreset] = useState<GitHubPreset>('issues')
  const [defaultGitHubPreset, setDefaultGitHubPreset] = useState<GitHubPreset>('issues')
  const [gitlabView, setGitlabView] = useState<GitLabView>('project')
  const [gitlabFilter, setGitlabFilter] = useState<GitLabFilter>('opened')
  const [linearFilter, setLinearFilter] = useState<LinearFilter>('all')
  const [linearViewMode, setLinearViewMode] = useState<LinearViewMode>('list')
  const [linearGroupBy, setLinearGroupBy] = useState<LinearGroupBy>('none')
  const [linearOrderBy, setLinearOrderBy] = useState<LinearOrderBy>('priority')
  const [linearDisplayProperties, setLinearDisplayProperties] = useState<
    ReadonlySet<LinearDisplayProperty>
  >(() => new Set(DEFAULT_LINEAR_DISPLAY_PROPERTIES))
  const [linearTeamPropertyTouched, setLinearTeamPropertyTouched] = useState(false)
  const [linearWorkspaces, setLinearWorkspaces] = useState<LinearWorkspace[]>([])
  const [selectedLinearWorkspaceId, setSelectedLinearWorkspaceId] = useState<string | 'all' | null>(
    null
  )
  const [selectedLinearTeamIds, setSelectedLinearTeamIds] = useState<Set<string>>(new Set())
  const defaultRepoSelectionRef = useRef<string[] | null>(null)
  const repoSelectionHydratedRef = useRef(false)
  const defaultLinearTeamSelectionRef = useRef<string[] | null>(null)
  const [showLinearWorkspacePicker, setShowLinearWorkspacePicker] = useState(false)
  const [showLinearTeamPicker, setShowLinearTeamPicker] = useState(false)
  const [showLinearViewPicker, setShowLinearViewPicker] = useState(false)
  const [showLinearGroupPicker, setShowLinearGroupPicker] = useState(false)
  const [showLinearOrderPicker, setShowLinearOrderPicker] = useState(false)
  const [showLinearDisplayPicker, setShowLinearDisplayPicker] = useState(false)
  const [showLinearConnect, setShowLinearConnect] = useState(false)
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState('')
  const [linearConnectState, setLinearConnectState] = useState<'idle' | 'connecting' | 'error'>(
    'idle'
  )
  const [linearConnectError, setLinearConnectError] = useState('')
  const [taskSort, setTaskSort] = useState<TaskSort>('updated')
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set())
  const [items, setItems] = useState<TaskItem[]>([])
  const [githubPages, setGithubPages] = useState<
    Array<Extract<TaskItem, { provider: 'github' }>[]>
  >([])
  const [githubCurrentPage, setGithubCurrentPage] = useState(0)
  const [githubTotalCount, setGithubTotalCount] = useState<number | null>(null)
  const [githubPaginationLoading, setGithubPaginationLoading] = useState(false)
  const [githubLoadingTargetPage, setGithubLoadingTargetPage] = useState<number | null>(null)
  const [githubRepoSources, setGithubRepoSources] = useState<Record<string, GitHubRepoSources>>({})
  const [githubSourceErrors, setGithubSourceErrors] = useState<GitHubIssueSourceError[]>([])
  const [githubSourceFallbacks, setGithubSourceFallbacks] = useState<GitHubIssueSourceFallback[]>(
    []
  )
  const [retryingGithubSourceRepoPaths, setRetryingGithubSourceRepoPaths] = useState<Set<string>>(
    new Set()
  )
  const [githubRepoSlugCache, setGithubRepoSlugCache] = useState<
    Record<string, GitHubRepoSlugCacheEntry | undefined>
  >({})
  const [query, setQuery] = useState(getTaskPresetQuery('issues'))
  const [appliedQuery, setAppliedQuery] = useState(getTaskPresetQuery('issues'))
  const [showProviderPicker, setShowProviderPicker] = useState(false)
  const [showGitHubKindPicker, setShowGitHubKindPicker] = useState(false)
  const [showGitHubPresetPicker, setShowGitHubPresetPicker] = useState(false)
  const [showGitLabViewPicker, setShowGitLabViewPicker] = useState(false)
  const [showGitLabFilterPicker, setShowGitLabFilterPicker] = useState(false)
  const [showLinearFilterPicker, setShowLinearFilterPicker] = useState(false)
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showRepoPicker, setShowRepoPicker] = useState(false)
  const [showGitHubIssueSourcePicker, setShowGitHubIssueSourcePicker] = useState(false)
  const [showGitHubPagePicker, setShowGitHubPagePicker] = useState(false)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showCreateTargetPicker, setShowCreateTargetPicker] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createBody, setCreateBody] = useState('')
  const [createRepoId, setCreateRepoId] = useState<string | null>(null)
  const [createTeamId, setCreateTeamId] = useState<string | null>(null)
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([])
  const [creatingTask, setCreatingTask] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [tasksSupportState, setTasksSupportState] = useState<TasksSupportState>({
    kind: 'unknown',
    client: null
  })
  const [error, setError] = useState('')
  const [actionItem, setActionItem] = useState<ActionableTaskItem | null>(null)
  const [mergeMethodTaskItem, setMergeMethodTaskItem] = useState<
    Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }> | null
  >(null)
  const [mergeMethodProjectRow, setMergeMethodProjectRow] = useState<GitHubProjectRow | null>(null)
  const [pendingHostedMerge, setPendingHostedMerge] = useState<PendingHostedMerge | null>(null)
  const [pendingProjectGitHubMerge, setPendingProjectGitHubMerge] =
    useState<PendingProjectGitHubMerge | null>(null)
  const [pendingHostedStateChange, setPendingHostedStateChange] =
    useState<PendingHostedStateChange | null>(null)
  const [detailPayload, setDetailPayload] = useState<DetailPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRefreshSeq, setDetailRefreshSeq] = useState(0)
  const [itemTitleDraft, setItemTitleDraft] = useState('')
  const [itemBodyDraft, setItemBodyDraft] = useState('')
  const [itemCommentDraft, setItemCommentDraft] = useState('')
  const [itemAddLabelsDraft, setItemAddLabelsDraft] = useState('')
  const [itemRemoveLabelsDraft, setItemRemoveLabelsDraft] = useState('')
  const [itemAddAssigneesDraft, setItemAddAssigneesDraft] = useState('')
  const [itemRemoveAssigneesDraft, setItemRemoveAssigneesDraft] = useState('')
  const [itemAvailableLabels, setItemAvailableLabels] = useState<string[]>([])
  const [itemLabelsLoading, setItemLabelsLoading] = useState(false)
  const [itemLabelsError, setItemLabelsError] = useState('')
  const [itemAssignableUsers, setItemAssignableUsers] = useState<GitHubAssignableUser[]>([])
  const [itemAssignableUsersLoading, setItemAssignableUsersLoading] = useState(false)
  const [itemAssignableUsersError, setItemAssignableUsersError] = useState('')
  const [itemReviewersDraft, setItemReviewersDraft] = useState('')
  const [itemReplyDrafts, setItemReplyDrafts] = useState<Record<string, string>>({})
  const [expandedPrFilePath, setExpandedPrFilePath] = useState<string | null>(null)
  const [prFileContents, setPrFileContents] = useState<Record<string, GitHubPRFileContents>>({})
  const [prFileLoadingPath, setPrFileLoadingPath] = useState<string | null>(null)
  const [prFileCommentDrafts, setPrFileCommentDrafts] = useState<Record<string, string>>({})
  const [copiedLinkKey, setCopiedLinkKey] = useState<string | null>(null)
  const copiedLinkResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expandedResolvedCommentGroups, setExpandedResolvedCommentGroups] = useState<Set<string>>(
    () => new Set()
  )
  const detailCommentGroups = useMemo(
    () => groupDetailComments(detailPayload?.comments ?? []),
    [detailPayload?.comments]
  )
  const [workspaceRepoPickerItem, setWorkspaceRepoPickerItem] = useState<Extract<
    TaskItem,
    { provider: 'linear' }
  > | null>(null)
  const [workspaceCreateDraft, setWorkspaceCreateDraft] = useState<WorkspaceCreateDraft | null>(
    null
  )
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('')
  const [workspaceLastAutoName, setWorkspaceLastAutoName] = useState('')
  const [workspaceBranchAutoName, setWorkspaceBranchAutoName] = useState('')
  const [workspaceBranchNameOverride, setWorkspaceBranchNameOverride] = useState<
    string | undefined
  >(undefined)
  const [workspaceBaseBranch, setWorkspaceBaseBranch] = useState<BaseRefSearchResult | null>(null)
  const [workspaceBaseBranchQuery, setWorkspaceBaseBranchQuery] = useState('')
  const [workspaceBaseBranchResults, setWorkspaceBaseBranchResults] = useState<
    BaseRefSearchResult[]
  >([])
  const [workspaceBaseBranchLoading, setWorkspaceBaseBranchLoading] = useState(false)
  const [workspaceBaseBranchError, setWorkspaceBaseBranchError] = useState('')
  const [workspaceSparsePresets, setWorkspaceSparsePresets] = useState<SparsePreset[]>([])
  const [workspaceSparsePresetsLoading, setWorkspaceSparsePresetsLoading] = useState(false)
  const [workspaceSparsePresetsLoaded, setWorkspaceSparsePresetsLoaded] = useState(false)
  const [_workspaceSparsePresetsError, setWorkspaceSparsePresetsError] = useState('')
  const [workspaceSparseReloadKey, setWorkspaceSparseReloadKey] = useState(0)
  const [workspaceSparsePresetId, setWorkspaceSparsePresetId] = useState<string | null>(null)
  const [workspaceSparseDraft, setWorkspaceSparseDraft] = useState<WorkspaceSparseDraft | null>(
    null
  )
  const [workspaceSparseSaving, setWorkspaceSparseSaving] = useState(false)
  const [workspaceAgent, setWorkspaceAgent] = useState<WorkspaceAgentChoice | null>(null)
  const [workspaceAgentOverridden, setWorkspaceAgentOverridden] = useState(false)
  const [workspaceDetectedAgentIds, setWorkspaceDetectedAgentIds] = useState<Set<string> | null>(
    null
  )
  const [workspaceSshState, setWorkspaceSshState] = useState<SshConnectionState | null>(null)
  const [workspaceSshConnecting, setWorkspaceSshConnecting] = useState(false)
  const [showWorkspaceAgentPicker, setShowWorkspaceAgentPicker] = useState(false)
  const [showWorkspaceCreateRepoPicker, setShowWorkspaceCreateRepoPicker] = useState(false)
  const [showWorkspaceAdvanced, setShowWorkspaceAdvanced] = useState(false)
  const [showWorkspaceBaseBranchPicker, setShowWorkspaceBaseBranchPicker] = useState(false)
  const [showWorkspaceSparsePicker, setShowWorkspaceSparsePicker] = useState(false)
  const [linearStatusPickerItem, setLinearStatusPickerItem] = useState<Extract<
    TaskItem,
    { provider: 'linear' }
  > | null>(null)
  const [setupPrompt, setSetupPrompt] = useState<SetupPrompt | null>(null)
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const [mutatingStatus, setMutatingStatus] = useState(false)
  const [linearStates, setLinearStates] = useState<LinearState[]>([])
  const [linearStatesLoading, setLinearStatesLoading] = useState(false)
  const [linearCommentDraft, setLinearCommentDraft] = useState('')
  const [linearSubIssueTitle, setLinearSubIssueTitle] = useState('')
  const [taskStateHydrated, setTaskStateHydrated] = useState(false)
  const [runtimeTaskSettings, setRuntimeTaskSettings] = useState<RuntimeTaskSettings>({})
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [orcaYamlTrustPrompt, setOrcaYamlTrustPrompt] = useState<OrcaYamlTrustPrompt | null>(null)
  const [githubProjectSettings, setGithubProjectSettings] = useState<GitHubProjectSettings>(
    EMPTY_GITHUB_PROJECT_SETTINGS
  )
  const [githubProjects, setGithubProjects] = useState<GitHubProjectSummary[]>([])
  const [githubProjectViews, setGithubProjectViews] = useState<GitHubProjectViewSummary[]>([])
  const [githubProjectTable, setGithubProjectTable] = useState<GitHubProjectTable | null>(null)
  const [githubProjectLoading, setGithubProjectLoading] = useState(false)
  const [githubProjectError, setGithubProjectError] = useState('')
  const [githubProjectPartialFailures, setGithubProjectPartialFailures] = useState<
    GitHubProjectPartialFailure[]
  >([])
  const [githubProjectSearch, setGithubProjectSearch] = useState('')
  const [githubProjectPickerSearch, setGithubProjectPickerSearch] = useState('')
  const [githubProjectPasteInput, setGithubProjectPasteInput] = useState('')
  const [githubProjectPasteError, setGithubProjectPasteError] = useState('')
  const [githubProjectPasteBusy, setGithubProjectPasteBusy] = useState(false)
  const [appliedGithubProjectSearch, setAppliedGithubProjectSearch] = useState<string | undefined>(
    undefined
  )
  const [githubProjectSortOverride, setGithubProjectSortOverride] =
    useState<ProjectSortOverride | null>(null)
  const [githubProjectHiddenFieldIdsByView, setGithubProjectHiddenFieldIdsByView] = useState<
    Record<string, string[]>
  >({})
  const [collapsedGitHubProjectGroups, setCollapsedGitHubProjectGroups] = useState<Set<string>>(
    () => new Set()
  )
  const [showGitHubProjectPicker, setShowGitHubProjectPicker] = useState(false)
  const [showGitHubProjectViewPicker, setShowGitHubProjectViewPicker] = useState(false)
  const [showGitHubProjectSortPicker, setShowGitHubProjectSortPicker] = useState(false)
  const [showGitHubProjectFieldsPicker, setShowGitHubProjectFieldsPicker] = useState(false)
  const [pendingGitHubProjectViewSelection, setPendingGitHubProjectViewSelection] =
    useState<GitHubProjectRef | null>(null)
  const [projectRowItem, setProjectRowItem] = useState<GitHubProjectRow | null>(null)
  const [projectRowDetail, setProjectRowDetail] = useState<DetailPayload | null>(null)
  const [projectRowDetailLoading, setProjectRowDetailLoading] = useState(false)
  const [projectRowDetailError, setProjectRowDetailError] = useState('')
  const [projectRowDetailRefreshSeq, setProjectRowDetailRefreshSeq] = useState(0)
  const [projectTitleDraft, setProjectTitleDraft] = useState('')
  const [projectBodyDraft, setProjectBodyDraft] = useState('')
  const [projectCommentDraft, setProjectCommentDraft] = useState('')
  const [projectEditingCommentId, setProjectEditingCommentId] = useState<string | null>(null)
  const [projectEditingCommentDraft, setProjectEditingCommentDraft] = useState('')
  const [projectReviewersDraft, setProjectReviewersDraft] = useState('')
  const [projectFieldDrafts, setProjectFieldDrafts] = useState<Record<string, string>>({})
  const [projectAvailableLabels, setProjectAvailableLabels] = useState<string[]>([])
  const [projectLabelsLoading, setProjectLabelsLoading] = useState(false)
  const [projectLabelsError, setProjectLabelsError] = useState('')
  const [projectAssignableUsers, setProjectAssignableUsers] = useState<GitHubAssignableUser[]>([])
  const [projectAssignableUsersLoading, setProjectAssignableUsersLoading] = useState(false)
  const [projectAssignableUsersError, setProjectAssignableUsersError] = useState('')
  const [projectIssueTypes, setProjectIssueTypes] = useState<GitHubIssueType[]>([])
  const [projectIssueTypesLoading, setProjectIssueTypesLoading] = useState(false)
  const [projectIssueTypesError, setProjectIssueTypesError] = useState('')
  const [projectMutating, setProjectMutating] = useState(false)
  const [projectRepoNotInOrca, setProjectRepoNotInOrca] =
    useState<ProjectRepoNotInOrcaPrompt | null>(null)
  // Why: project detail text inputs rerender this screen while comments stay
  // unchanged; keep grouping out of the typing path.
  const projectDetailCommentGroups = useMemo(
    () =>
      groupDetailComments(projectRowDetail?.provider === 'github' ? projectRowDetail.comments : []),
    [projectRowDetail]
  )
  const requestedTaskSource = useMemo(
    () => (isTaskProvider(taskSource) ? taskSource : undefined),
    [taskSource]
  )
  const linearMetadataItem = actionItem?.provider === 'linear' ? actionItem : linearStatusPickerItem
  const tasksSupported =
    connState === 'connected' &&
    client != null &&
    tasksSupportState.kind === 'supported' &&
    tasksSupportState.client === client
  const tasksUnsupported =
    connState === 'connected' &&
    client != null &&
    tasksSupportState.kind === 'unsupported' &&
    tasksSupportState.client === client
  const taskUiReady = tasksSupported && taskStateHydrated
  const hostedRepos = useMemo(() => repos.filter(isHostedTaskRepo), [repos])
  const workspaceRepos = useMemo(() => repos.filter((repo) => repo.kind !== 'folder'), [repos])
  const reposById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const selectedHostedRepos = useMemo(
    () =>
      selectedRepoIds.size === 0
        ? hostedRepos
        : hostedRepos.filter((repo) => selectedRepoIds.has(repo.id)),
    [hostedRepos, selectedRepoIds]
  )
  const findProjectRowRepo = useCallback(
    (row: GitHubProjectRow): RepoSummary | null =>
      findRepoForGitHubProjectRepository(
        row.content.repository,
        hostedRepos,
        githubRepoSlugCache
      ) as RepoSummary | null,
    [githubRepoSlugCache, hostedRepos]
  )
  const githubProjectRepoSlugReady = useMemo(
    () =>
      hostedRepos.every((repo) => {
        const cached = githubRepoSlugCache[repo.id]
        return cached !== undefined && cached.path === repo.path
      }),
    [githubRepoSlugCache, hostedRepos]
  )
  const visibleGitHubProjectRows = useMemo(
    () =>
      githubProjectTable
        ? (filterGitHubProjectRowsForRepos(
            githubProjectTable.rows,
            hostedRepos,
            githubRepoSlugCache
          ) as GitHubProjectRow[])
        : [],
    [githubProjectTable, githubRepoSlugCache, hostedRepos]
  )
  const visibleGitHubProjectGroups = useMemo<ProjectGroup[]>(() => {
    if (!githubProjectTable) {
      return []
    }
    const normalizedTable = normalizeProjectTableForMobileSort(
      githubProjectTable,
      visibleGitHubProjectRows,
      githubProjectSortOverride
    )
    const sorted = sortRows(normalizedTable, normalizedTable.rows)
    return groupRows(normalizedTable, sorted)
  }, [githubProjectSortOverride, githubProjectTable, visibleGitHubProjectRows])
  const githubProjectListEntries = useMemo<ProjectListEntry[]>(() => {
    const grouped = githubProjectTable?.selectedView.groupByFields?.[0] != null
    if (!grouped) {
      return visibleGitHubProjectGroups.flatMap((group) =>
        group.rows.map((row) => ({
          type: 'row' as const,
          row: row as unknown as GitHubProjectRow
        }))
      )
    }
    return visibleGitHubProjectGroups.flatMap((group) => {
      const collapsed = collapsedGitHubProjectGroups.has(group.key)
      const header: ProjectListEntry = { type: 'group', group, collapsed }
      if (collapsed) {
        return [header]
      }
      return [
        header,
        ...group.rows.map((row) => ({
          type: 'row' as const,
          row: row as unknown as GitHubProjectRow
        }))
      ]
    })
  }, [collapsedGitHubProjectGroups, githubProjectTable, visibleGitHubProjectGroups])
  const githubProjectAvailableSummaryFields = useMemo(
    () => projectSummaryFields(githubProjectTable),
    [githubProjectTable]
  )
  const githubProjectFieldVisibilityScope = projectFieldVisibilityKey(githubProjectTable)
  const githubProjectHiddenFieldIds = useMemo(
    () =>
      new Set(
        githubProjectFieldVisibilityScope
          ? (githubProjectHiddenFieldIdsByView[githubProjectFieldVisibilityScope] ?? [])
          : []
      ),
    [githubProjectFieldVisibilityScope, githubProjectHiddenFieldIdsByView]
  )
  const githubProjectSummaryFields = useMemo(
    () =>
      githubProjectAvailableSummaryFields.filter(
        (field) => !githubProjectHiddenFieldIds.has(field.id)
      ),
    [githubProjectAvailableSummaryFields, githubProjectHiddenFieldIds]
  )

  useEffect(() => {
    if (
      !client ||
      connState !== 'connected' ||
      !tasksSupported ||
      !taskStateHydrated ||
      provider !== 'github' ||
      githubMode !== 'project'
    ) {
      return
    }
    const missing = hostedRepos.filter((repo) => {
      const cached = githubRepoSlugCache[repo.id]
      return !cached || cached.path !== repo.path
    })
    if (missing.length === 0) {
      return
    }

    let cancelled = false
    void mapWithConcurrency(missing, GITHUB_REPO_CONCURRENCY, async (repo) => {
      try {
        const response = await client.sendRequest(
          'github.repoSlug',
          { repo: `id:${repo.id}` },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as GitHubOwnerRepo | null
        return {
          repoId: repo.id,
          path: repo.path,
          slug: result ? `${result.owner}/${result.repo}` : null
        }
      } catch {
        return { repoId: repo.id, path: repo.path, slug: null }
      }
    }).then((entries) => {
      if (cancelled) {
        return
      }
      setGithubRepoSlugCache((current) => {
        const next = { ...current }
        for (const entry of entries) {
          next[entry.repoId] = { path: entry.path, slug: entry.slug }
        }
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    client,
    connState,
    githubMode,
    githubRepoSlugCache,
    hostedRepos,
    provider,
    taskStateHydrated,
    tasksSupported
  ])
  const activeGitHubProject = githubProjectSettings.activeProject
  const activeGitHubProjectKey = activeGitHubProject ? githubProjectKey(activeGitHubProject) : null
  const activeGitHubProjectViewId = activeGitHubProjectKey
    ? githubProjectSettings.lastViewByProject[activeGitHubProjectKey]?.viewId
    : undefined
  const activeGitHubProjectView =
    githubProjectViews.find((view) => view.id === activeGitHubProjectViewId) ??
    (githubProjectTable
      ? {
          id: githubProjectTable.selectedView.id,
          number: githubProjectTable.selectedView.number,
          name: githubProjectTable.selectedView.name,
          layout: githubProjectTable.selectedView.layout
        }
      : null)
  const projectIssueTypeRepository =
    projectRowItem?.itemType === 'ISSUE' ? projectRowItem.content.repository : null
  const projectMetadataRepository =
    projectRowItem && projectRowType(projectRowItem) ? projectRowItem.content.repository : null
  const projectRowHostedRepo = useMemo(
    () => (projectRowItem ? findProjectRowRepo(projectRowItem) : null),
    [findProjectRowRepo, projectRowItem]
  )
  const itemReviewerCandidates = useMemo(() => {
    if (!actionItem || actionItem.provider !== 'github' || actionItem.source.type !== 'pr') {
      return []
    }
    const reviewerSeedUsers = getGitHubReviewerSeedUsers({
      reviewRequests:
        detailPayload?.provider === 'github'
          ? detailPayload.reviewRequests
          : actionItem.source.reviewRequests,
      latestReviews:
        detailPayload?.provider === 'github'
          ? detailPayload.latestReviews
          : actionItem.source.latestReviews,
      author: actionItem.source.author
    })
    const authorLogin = actionItem.source.author?.trim().toLowerCase() ?? null
    return mergeGitHubAssignableUsers(itemAssignableUsers, reviewerSeedUsers).filter(
      (user) => user.login.trim().toLowerCase() !== authorLogin
    )
  }, [actionItem, detailPayload, itemAssignableUsers])
  const itemSelectedReviewerLogins = useMemo(() => {
    if (!actionItem || actionItem.provider !== 'github' || actionItem.source.type !== 'pr') {
      return new Set<string>()
    }
    const reviewRequests =
      detailPayload?.provider === 'github'
        ? detailPayload.reviewRequests
        : (actionItem.source.reviewRequests ?? [])
    return new Set(
      reviewRequests.map((reviewer) => reviewer.login.trim().toLowerCase()).filter(Boolean)
    )
  }, [actionItem, detailPayload])
  const projectReviewerCandidates = useMemo(() => {
    if (
      !projectRowItem ||
      projectRowItem.itemType !== 'PULL_REQUEST' ||
      projectRowDetail?.provider !== 'github'
    ) {
      return []
    }
    const reviewerSeedUsers = getGitHubReviewerSeedUsers({
      reviewRequests: projectRowDetail.reviewRequests,
      latestReviews: projectRowDetail.latestReviews
    })
    return mergeGitHubAssignableUsers(projectAssignableUsers, reviewerSeedUsers)
  }, [projectAssignableUsers, projectRowDetail, projectRowItem])
  const projectSelectedReviewerLogins = useMemo(() => {
    if (projectRowDetail?.provider !== 'github') {
      return new Set<string>()
    }
    return new Set(
      projectRowDetail.reviewRequests
        .map((reviewer) => reviewer.login.trim().toLowerCase())
        .filter(Boolean)
    )
  }, [projectRowDetail])
  const projectMetadataSeedLogins = useMemo(() => {
    const logins = new Set<string>()
    for (const assignee of projectRowItem?.content.assignees ?? []) {
      const login = assignee.login.trim()
      if (login) {
        logins.add(login)
      }
    }
    for (const reviewer of projectRowDetail?.provider === 'github'
      ? getGitHubReviewerSeedUsers(projectRowDetail)
      : []) {
      const login = reviewer.login.trim()
      if (login) {
        logins.add(login)
      }
    }
    return [...logins].sort().join(',')
  }, [projectRowDetail, projectRowItem?.content.assignees])

  // Why: task-loading effects use this as a stale-client guard, so the ref
  // must be current before those passive effects can run after commit.
  useLayoutEffect(() => {
    clientRef.current = client
  }, [client])

  const persistTaskResumeState = useCallback(
    (updates: Partial<TaskResumeState>) => {
      if (!client || !taskUiReady) {
        return
      }
      const next = { ...taskResumeRef.current, ...updates }
      taskResumeRef.current = next
      void client.sendRequest('ui.set', { taskResumeState: next }).catch(() => {
        // Best-effort: desktop treats task resume as a convenience preference.
      })
    },
    [client, taskUiReady]
  )

  const toggleGitHubProjectFieldVisibility = useCallback(
    (fieldId: string) => {
      if (!githubProjectFieldVisibilityScope) {
        return
      }
      setGithubProjectHiddenFieldIdsByView((current) => {
        const hidden = new Set(current[githubProjectFieldVisibilityScope] ?? [])
        if (hidden.has(fieldId)) {
          hidden.delete(fieldId)
        } else {
          hidden.add(fieldId)
        }
        const next = { ...current }
        if (hidden.size === 0) {
          delete next[githubProjectFieldVisibilityScope]
        } else {
          next[githubProjectFieldVisibilityScope] = [...hidden]
        }
        persistTaskResumeState({ githubProjectHiddenFieldIdsByView: next })
        return next
      })
    },
    [githubProjectFieldVisibilityScope, persistTaskResumeState]
  )

  const persistTaskSource = useCallback(
    (nextProvider: TaskProvider) => {
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { defaultTaskSource: nextProvider }).catch(() => {
        // Best-effort: a failed settings write should not block switching views.
      })
    },
    [client, taskUiReady]
  )

  const persistRepoSelection = useCallback(
    (selection: Set<string>, allRepos: RepoSummary[]) => {
      if (!client || !taskUiReady) {
        return
      }
      const nextSelection =
        selection.size === 0 || selection.size === allRepos.length ? null : [...selection]
      defaultRepoSelectionRef.current = nextSelection
      void client
        .sendRequest('settings.update', { defaultRepoSelection: nextSelection })
        .catch(() => {
          // Best-effort: the in-memory repo picker already reflects the change.
        })
    },
    [client, taskUiReady]
  )

  const persistDefaultGitHubPreset = useCallback(
    (preset: GitHubPreset) => {
      setDefaultGitHubPreset(preset)
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { defaultTaskViewPreset: preset }).catch(() => {
        // Best-effort: the current session still uses the selected preset.
      })
    },
    [client, taskUiReady]
  )

  const persistGitHubProjectSettings = useCallback(
    (nextSettings: GitHubProjectSettings) => {
      setGithubProjectSettings(nextSettings)
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { githubProjects: nextSettings }).catch(() => {
        // Best-effort: project selection can still work for the current session.
      })
    },
    [client, taskUiReady]
  )

  const persistSetupHookTrust = useCallback(
    async (repoId: string, contentHash: string, alwaysTrust: boolean): Promise<void> => {
      if (!client) {
        return
      }
      const next = trustedOrcaHooksWithSetupApproval({
        trust: trustedOrcaHooks,
        repoId,
        contentHash,
        alwaysTrust
      })
      const response = await client.sendRequest('ui.set', { trustedOrcaHooks: next })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      setTrustedOrcaHooks(next)
    },
    [client, trustedOrcaHooks]
  )

  const resetWorkspaceCreateState = useCallback((): void => {
    setWorkspaceRepoPickerItem(null)
    setWorkspaceCreateDraft(null)
    setWorkspaceNameDraft('')
    setWorkspaceLastAutoName('')
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setWorkspaceBaseBranch(null)
    setWorkspaceBaseBranchQuery('')
    setWorkspaceBaseBranchResults([])
    setWorkspaceBaseBranchLoading(false)
    setWorkspaceBaseBranchError('')
    setWorkspaceSparsePresets([])
    setWorkspaceSparsePresetsLoading(false)
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    setWorkspaceSparseReloadKey(0)
    setWorkspaceSparsePresetId(null)
    setWorkspaceSparseDraft(null)
    setWorkspaceSparseSaving(false)
    setWorkspaceAgent(null)
    setWorkspaceAgentOverridden(false)
    setWorkspaceDetectedAgentIds(null)
    setWorkspaceSshState(null)
    setWorkspaceSshConnecting(false)
    setShowWorkspaceAgentPicker(false)
    setShowWorkspaceCreateRepoPicker(false)
    setShowWorkspaceAdvanced(false)
    setShowWorkspaceBaseBranchPicker(false)
    setShowWorkspaceSparsePicker(false)
    setSetupPrompt(null)
    setOrcaYamlTrustPrompt(null)
  }, [])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      taskResumeRef.current = {}
      defaultRepoSelectionRef.current = null
      repoSelectionHydratedRef.current = false
      setRuntimeTaskSettings({})
      setTrustedOrcaHooks({})
      setOrcaYamlTrustPrompt(null)
      setGithubProjectHiddenFieldIdsByView({})
      setTaskStateHydrated(false)
      setTasksSupportState({ kind: 'unknown', client: null })
      setShowLinearWorkspacePicker(false)
      setShowLinearTeamPicker(false)
      setShowLinearViewPicker(false)
      setShowLinearGroupPicker(false)
      setShowLinearOrderPicker(false)
      setShowLinearDisplayPicker(false)
      setShowLinearConnect(false)
      setShowProviderPicker(false)
      setShowGitHubKindPicker(false)
      setShowGitHubPresetPicker(false)
      setShowGitLabViewPicker(false)
      setShowGitLabFilterPicker(false)
      setShowLinearFilterPicker(false)
      setShowSortPicker(false)
      setShowRepoPicker(false)
      setShowGitHubIssueSourcePicker(false)
      setShowGitHubPagePicker(false)
      setShowGitHubProjectPicker(false)
      setShowGitHubProjectViewPicker(false)
      setShowGitHubProjectSortPicker(false)
      setShowGitHubProjectFieldsPicker(false)
      setPendingGitHubProjectViewSelection(null)
      setActionItem(null)
      setProjectRowItem(null)
      setProjectRepoNotInOrca(null)
      setDetailPayload(null)
      setProjectRowDetail(null)
      setShowCreateTask(false)
      setShowCreateTargetPicker(false)
      setLinearStatusPickerItem(null)
      setPendingHostedMerge(null)
      setPendingProjectGitHubMerge(null)
      setPendingHostedStateChange(null)
      setMergeMethodTaskItem(null)
      setMergeMethodProjectRow(null)
      resetWorkspaceCreateState()
      return
    }

    let stale = false
    setTaskStateHydrated(false)
    setTasksSupportState({ kind: 'unknown', client })
    setShowLinearWorkspacePicker(false)
    setShowLinearTeamPicker(false)
    setShowLinearViewPicker(false)
    setShowLinearGroupPicker(false)
    setShowLinearOrderPicker(false)
    setShowLinearDisplayPicker(false)
    setShowLinearConnect(false)
    setShowProviderPicker(false)
    setShowGitHubKindPicker(false)
    setShowGitHubPresetPicker(false)
    setShowGitLabViewPicker(false)
    setShowGitLabFilterPicker(false)
    setShowLinearFilterPicker(false)
    setShowSortPicker(false)
    setShowRepoPicker(false)
    setShowGitHubIssueSourcePicker(false)
    setShowGitHubPagePicker(false)
    setShowGitHubProjectPicker(false)
    setShowGitHubProjectViewPicker(false)
    setShowGitHubProjectSortPicker(false)
    setShowGitHubProjectFieldsPicker(false)
    setPendingGitHubProjectViewSelection(null)
    setActionItem(null)
    setProjectRowItem(null)
    setProjectRepoNotInOrca(null)
    setDetailPayload(null)
    setProjectRowDetail(null)
    setShowCreateTask(false)
    setShowCreateTargetPicker(false)
    setLinearStatusPickerItem(null)
    setPendingHostedMerge(null)
    setPendingProjectGitHubMerge(null)
    setPendingHostedStateChange(null)
    setMergeMethodTaskItem(null)
    setMergeMethodProjectRow(null)
    resetWorkspaceCreateState()

    const hydrateTaskState = async (): Promise<void> => {
      const statusResponse = await client.sendRequest('status.get')
      if (stale) {
        return
      }
      if (!isSuccess(statusResponse)) {
        throw new Error(statusResponse.error.message)
      }
      const status = statusResponse.result as TaskRuntimeStatus
      if (!status.capabilities?.includes(MOBILE_TASKS_CAPABILITY)) {
        // Why: Tasks is additive RPC surface, so old desktop builds can still
        // pair but must not receive the newer task-specific method calls.
        setTasksSupportState({ kind: 'unsupported', client })
        setItems([])
        setGithubPages([])
        setGithubProjectTable(null)
        setShowLinearWorkspacePicker(false)
        setShowLinearTeamPicker(false)
        setShowLinearViewPicker(false)
        setShowLinearGroupPicker(false)
        setShowLinearOrderPicker(false)
        setShowLinearDisplayPicker(false)
        setShowLinearConnect(false)
        setShowProviderPicker(false)
        setShowGitHubKindPicker(false)
        setShowGitHubPresetPicker(false)
        setShowGitLabViewPicker(false)
        setShowGitLabFilterPicker(false)
        setShowLinearFilterPicker(false)
        setShowSortPicker(false)
        setShowRepoPicker(false)
        setShowGitHubIssueSourcePicker(false)
        setShowGitHubPagePicker(false)
        setShowGitHubProjectPicker(false)
        setShowGitHubProjectViewPicker(false)
        setShowGitHubProjectSortPicker(false)
        setShowGitHubProjectFieldsPicker(false)
        setPendingGitHubProjectViewSelection(null)
        setActionItem(null)
        setProjectRowItem(null)
        setProjectRepoNotInOrca(null)
        setDetailPayload(null)
        setProjectRowDetail(null)
        setShowCreateTask(false)
        setShowCreateTargetPicker(false)
        setLinearStatusPickerItem(null)
        setPendingHostedMerge(null)
        setPendingProjectGitHubMerge(null)
        setPendingHostedStateChange(null)
        setMergeMethodTaskItem(null)
        setMergeMethodProjectRow(null)
        resetWorkspaceCreateState()
        setError('Update Orca desktop to use Tasks on mobile.')
        setTaskStateHydrated(false)
        return
      }
      setTasksSupportState({ kind: 'supported', client })
      setError('')
      const [settingsResponse, uiResponse, preflightResponse, linearStatusResponse] =
        await Promise.all([
          client.sendRequest('settings.get'),
          client.sendRequest('ui.get'),
          client.sendRequest('preflight.check'),
          client.sendRequest('linear.status')
        ])
      if (stale) {
        return
      }

      const settings = isSuccess(settingsResponse)
        ? (((settingsResponse.result as { settings?: RuntimeTaskSettings }).settings ??
            {}) as RuntimeTaskSettings)
        : {}
      setRuntimeTaskSettings(settings)
      const uiState = isSuccess(uiResponse)
        ? (
            uiResponse.result as {
              ui?: {
                taskResumeState?: TaskResumeState
                trustedOrcaHooks?: PersistedTrustedOrcaHooks
              }
            }
          ).ui
        : null
      setTrustedOrcaHooks(uiState?.trustedOrcaHooks ?? {})
      const resume = uiState?.taskResumeState ?? {}
      taskResumeRef.current = resume
      setGithubProjectHiddenFieldIdsByView(resume.githubProjectHiddenFieldIdsByView ?? {})

      const preflight = isSuccess(preflightResponse)
        ? (preflightResponse.result as { glab?: { installed?: boolean } })
        : null
      const linearStatus = isSuccess(linearStatusResponse)
        ? (linearStatusResponse.result as LinearStatusResponse)
        : null
      const preferredProviders = normalizeVisibleTaskProviders(settings.visibleTaskProviders)
      const linearIsConnected = linearStatus?.connected === true
      const availableProviders = filterAvailableTaskProviders(preferredProviders, {
        gitlabInstalled: preflight?.glab?.installed === true,
        linearConnected: linearIsConnected
      })
      const nextVisibleProviders =
        preferredProviders.includes('linear') && !availableProviders.includes('linear')
          ? [...availableProviders, 'linear' as const]
          : availableProviders
      setLinearConnected(linearIsConnected)
      if (!linearIsConnected) {
        setLinearWorkspaces([])
        setLinearTeams([])
        setSelectedLinearTeamIds(new Set())
        setSelectedLinearWorkspaceId(null)
      }
      const nextProvider =
        requestedTaskSource && nextVisibleProviders.includes(requestedTaskSource)
          ? requestedTaskSource
          : resolveVisibleTaskProvider(
              isTaskProvider(settings.defaultTaskSource) ? settings.defaultTaskSource : undefined,
              nextVisibleProviders
            )
      const preset =
        resume.githubItemsPreset === null
          ? normalizeGitHubPreset(settings.defaultTaskViewPreset)
          : normalizeGitHubPreset(resume.githubItemsPreset ?? settings.defaultTaskViewPreset)
      const defaultPreset = normalizeGitHubPreset(settings.defaultTaskViewPreset)
      const githubQuery =
        resume.githubItemsPreset === null
          ? (resume.githubItemsQuery ?? '')
          : getTaskPresetQuery(preset)
      const nextLinearFilter = normalizeLinearFilter(resume.linearPreset)
      const nextLinearQuery = resume.linearQuery ?? ''
      defaultRepoSelectionRef.current = settings.defaultRepoSelection ?? null
      defaultLinearTeamSelectionRef.current = settings.defaultLinearTeamSelection ?? null
      const nextQuery =
        nextProvider === 'github' ? githubQuery : nextProvider === 'linear' ? nextLinearQuery : ''
      const nextAppliedQuery =
        nextProvider === 'github'
          ? scopeGitHubTaskSearch(githubQuery, githubKindFromQuery(githubQuery, preset))
          : nextQuery

      setVisibleProviders(nextVisibleProviders)
      setProvider(nextProvider)
      setGithubMode(resume.githubMode === 'project' ? 'project' : 'items')
      setDefaultGitHubPreset(defaultPreset)
      setGithubPreset(preset)
      setGithubKind(githubKindFromQuery(githubQuery, preset))
      setLinearFilter(nextLinearFilter)
      setGithubProjectSettings(settings.githubProjects ?? EMPTY_GITHUB_PROJECT_SETTINGS)
      setQuery(nextQuery)
      setAppliedQuery(nextAppliedQuery)
      setTaskStateHydrated(true)
    }

    void hydrateTaskState().catch((err) => {
      if (stale) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load Tasks settings')
      setTaskStateHydrated(false)
    })

    return () => {
      stale = true
    }
  }, [client, connState, requestedTaskSource, resetWorkspaceCreateState])

  useEffect(() => {
    if (visibleProviders.includes(provider)) {
      return
    }
    setProvider(resolveVisibleTaskProvider(provider, visibleProviders))
  }, [provider, visibleProviders])

  const loadRepos = useCallback(async (): Promise<RepoSummary[]> => {
    if (!client || connState !== 'connected') {
      return []
    }
    const response = await client.sendRequest('repo.list')
    if (!isSuccess(response)) {
      throw new Error(response.error.message)
    }
    const result = response.result as { repos: RepoSummary[] }
    reposRef.current = result.repos
    setRepos(result.repos)
    if (!repoSelectionHydratedRef.current) {
      repoSelectionHydratedRef.current = true
      setSelectedRepoIds(reconcileRepoSelection(result.repos, defaultRepoSelectionRef.current))
    } else {
      setSelectedRepoIds((current) => {
        if (current.size === 0) {
          return current
        }
        const availableIds = new Set(result.repos.filter(isHostedTaskRepo).map((repo) => repo.id))
        const next = new Set([...current].filter((id) => availableIds.has(id)))
        return next.size === current.size ? current : next
      })
    }
    return result.repos
  }, [client, connState])

  const loadLinearContext = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    const statusResponse = await client.sendRequest('linear.status')
    if (!isSuccess(statusResponse)) {
      throw new Error(statusResponse.error.message)
    }
    const status = statusResponse.result as LinearStatusResponse
    setLinearConnected(status.connected === true)
    if (status.connected !== true) {
      setLinearWorkspaces([])
      setLinearTeams([])
      setSelectedLinearTeamIds(new Set())
      setSelectedLinearWorkspaceId(null)
      return
    }
    const workspaces = status.workspaces ?? []
    const workspaceId =
      status.selectedWorkspaceId ?? status.activeWorkspaceId ?? workspaces[0]?.id ?? null
    setLinearWorkspaces(workspaces)
    setSelectedLinearWorkspaceId(workspaceId)

    const teamsResponse = await client.sendRequest('linear.listTeams', {
      workspaceId: workspaceId ?? undefined
    })
    if (!isSuccess(teamsResponse)) {
      throw new Error(teamsResponse.error.message)
    }
    const teams = teamsResponse.result as LinearTeam[]
    setLinearTeams(teams)
    setSelectedLinearTeamIds(reconcileTeamSelection(teams, defaultLinearTeamSelectionRef.current))
  }, [client, connState, tasksSupported])

  const persistLinearTeamSelection = useCallback(
    (teamIds: Set<string>, allTeams: LinearTeam[]) => {
      if (!client || !taskUiReady) {
        return
      }
      const selection = teamIds.size === allTeams.length ? null : [...teamIds]
      defaultLinearTeamSelectionRef.current = selection
      void client
        .sendRequest('settings.update', { defaultLinearTeamSelection: selection })
        .catch(() => {
          // Best-effort preference persistence; the local picker state already changed.
        })
    },
    [client, taskUiReady]
  )

  const fetchGitHubItemsPage = useCallback(
    async (
      requestClient: RpcClient,
      queriedRepos: RepoSummary[],
      before?: string
    ): Promise<{
      items: Array<Extract<TaskItem, { provider: 'github' }>>
      failedCount: number
      sourcesByRepoId: Record<string, GitHubRepoSources>
      sourceErrors: GitHubIssueSourceError[]
      sourceFallbacks: GitHubIssueSourceFallback[]
    }> => {
      const results = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          try {
            const response = await requestClient.sendRequest('github.listWorkItems', {
              repo: `id:${repo.id}`,
              limit: PER_REPO_FETCH_LIMIT,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind),
              before
            })
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            const envelope = response.result as {
              items: Array<Omit<GitHubWorkItem, 'repoId' | 'repoName'>>
              sources?: GitHubRepoSources
              errors?: { issues?: { message: string } }
              issueSourceFellBack?: true
            }
            return {
              items: envelope.items.map((item) => createGitHubTask(repo, item)),
              sources: envelope.sources,
              sourceError: extractGitHubIssueSourceError(repo, envelope),
              sourceFallback: extractGitHubIssueSourceFallback(repo, envelope),
              repoId: repo.id
            }
          } catch (err) {
            const isExpectedSshSkip = isGitHubWorkItemsSshRemoteRequiredError(err)
            const logWorkItemFetchFailure = isExpectedSshSkip ? console.log : console.warn
            logWorkItemFetchFailure(
              '[mobile tasks] failed to fetch github work items',
              repo.id,
              isExpectedSshSkip && err instanceof Error ? err.message : err
            )
            return {
              items: [] as Array<Extract<TaskItem, { provider: 'github' }>>,
              repoId: repo.id,
              error: err instanceof Error ? err.message : 'Failed to load GitHub tasks'
            }
          }
        }
      )

      const sourcesByRepoId: Record<string, GitHubRepoSources> = {}
      const sourceErrors: GitHubIssueSourceError[] = []
      const sourceFallbacks: GitHubIssueSourceFallback[] = []
      for (const result of results) {
        if (result.sources) {
          sourcesByRepoId[result.repoId] = result.sources
        }
        if (result.sourceError) {
          sourceErrors.push(result.sourceError)
        }
        if (result.sourceFallback) {
          sourceFallbacks.push(result.sourceFallback)
        }
      }

      return {
        items: results
          .flatMap((result) => result.items)
          .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
          .slice(0, CROSS_REPO_DISPLAY_LIMIT),
        failedCount: results.filter((result) => result.error).length,
        sourcesByRepoId,
        sourceErrors,
        sourceFallbacks
      }
    },
    [appliedQuery, githubKind]
  )

  const countGitHubItems = useCallback(
    async (requestClient: RpcClient, queriedRepos: RepoSummary[]): Promise<number> => {
      const counts = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          try {
            const response = await requestClient.sendRequest(
              'github.countWorkItems',
              {
                repo: `id:${repo.id}`,
                query: scopeGitHubTaskSearch(appliedQuery, githubKind)
              },
              { timeoutMs: 30_000 }
            )
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            return typeof response.result === 'number' ? response.result : 0
          } catch (err) {
            const isExpectedSshSkip = isGitHubWorkItemsSshRemoteRequiredError(err)
            const logWorkItemCountFailure = isExpectedSshSkip ? console.log : console.warn
            logWorkItemCountFailure(
              '[mobile tasks] failed to count github work items',
              repo.id,
              isExpectedSshSkip && err instanceof Error ? err.message : err
            )
            return 0
          }
        }
      )
      return counts.reduce((sum, count) => sum + count, 0)
    },
    [appliedQuery, githubKind]
  )

  const loadTasks = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
        return
      }
      const generation = loadGenerationRef.current + 1
      loadGenerationRef.current = generation
      const requestClient = client
      const isCurrent = () =>
        loadGenerationRef.current === generation && clientRef.current === requestClient
      setError('')
      if (options.silent) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      try {
        if (provider !== 'github' || githubMode !== 'items') {
          setGithubPages([])
          setGithubCurrentPage(0)
          setGithubTotalCount(null)
          setGithubSourceErrors([])
          setGithubSourceFallbacks([])
        }
        if (provider === 'github' && githubMode === 'project') {
          setItems([])
          return
        }
        if (provider === 'linear' && !linearConnected) {
          setItems([])
          return
        }
        const currentRepos = reposRef.current.length > 0 ? reposRef.current : await loadRepos()
        if (!isCurrent()) {
          return
        }
        if (provider === 'github' || provider === 'gitlab') {
          const supportedRepos = currentRepos.filter(isHostedTaskRepo)
          const queriedRepos =
            selectedRepoIds.size === 0
              ? supportedRepos
              : supportedRepos.filter((repo) => selectedRepoIds.has(repo.id))
          if (queriedRepos.length === 0) {
            if (!isCurrent()) {
              return
            }
            setItems([])
            setGithubPages([])
            setGithubCurrentPage(0)
            setGithubTotalCount(null)
            setGithubSourceErrors([])
            setGithubSourceFallbacks([])
            return
          }
          if (provider === 'github') {
            const page = await fetchGitHubItemsPage(requestClient, queriedRepos)
            if (!isCurrent()) {
              return
            }
            setGithubRepoSources((current) => ({ ...current, ...page.sourcesByRepoId }))
            setGithubSourceErrors(page.sourceErrors)
            setGithubSourceFallbacks(page.sourceFallbacks)
            if (page.failedCount === queriedRepos.length) {
              throw new Error('Failed to load GitHub tasks')
            }
            setGithubPages([page.items])
            setGithubCurrentPage(0)
            setItems(page.items)
            if (selectedRepoIds.size > 0) {
              void countGitHubItems(requestClient, queriedRepos).then((count) => {
                if (isCurrent()) {
                  setGithubTotalCount(count)
                }
              })
            } else {
              // Why: the default all-repos view must not spend GitHub Search
              // quota on totals before the user narrows the repository scope.
              setGithubTotalCount(null)
            }
            if (page.failedCount > 0) {
              setError(buildPartialRepositoryNotice(page.failedCount, queriedRepos.length))
            } else {
              setError('')
            }
            return
          }
          if (provider === 'gitlab' && gitlabView === 'todos') {
            setGithubPages([])
            setGithubCurrentPage(0)
            setGithubTotalCount(null)
            setGithubSourceErrors([])
            setGithubSourceFallbacks([])
            const response = await requestClient.sendRequest('gitlab.todos', {
              repo: `id:${queriedRepos[0]!.id}`
            })
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            if (!isCurrent()) {
              return
            }
            setItems(
              ((response.result as GitLabTodo[]) ?? [])
                .map(createGitLabTodoTask)
                .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
            )
            return
          }
          setGithubPages([])
          setGithubCurrentPage(0)
          setGithubTotalCount(null)
          setGithubSourceErrors([])
          setGithubSourceFallbacks([])
          const results = await mapWithConcurrency(
            queriedRepos,
            GITHUB_REPO_CONCURRENCY,
            async (repo) => {
              try {
                const response = await requestClient.sendRequest('gitlab.listWorkItems', {
                  repo: `id:${repo.id}`,
                  state: gitlabFilter,
                  page: 1,
                  perPage: GITLAB_PER_PAGE,
                  query: appliedQuery.trim() || undefined
                })
                if (!isSuccess(response)) {
                  throw new Error(response.error.message)
                }
                const envelope = response.result as {
                  items: Array<Omit<GitLabWorkItem, 'repoId' | 'repoName'>>
                  error?: { type?: string; message: string }
                }
                if (envelope.error?.type && envelope.error.type !== 'not_found') {
                  return { items: [], error: envelope.error.message }
                }
                return { items: envelope.items.map((item) => createGitLabTask(repo, item)) }
              } catch (err) {
                console.warn(`[mobile tasks] failed to fetch ${provider} work items`, repo.id, err)
                return {
                  items: [] as TaskItem[],
                  error: err instanceof Error ? err.message : 'Failed to load GitLab tasks'
                }
              }
            }
          )
          if (!isCurrent()) {
            return
          }
          const failedCount = results.filter((result) => result.error).length
          if (failedCount === queriedRepos.length) {
            throw new Error(
              results.find((result) => result.error)?.error ?? 'Failed to load GitLab tasks'
            )
          }
          setItems(
            results
              .flatMap((result) => result.items)
              .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
          )
          if (failedCount > 0) {
            setError(buildPartialRepositoryNotice(failedCount, queriedRepos.length))
          } else {
            setError('')
          }
        } else {
          const normalizedQuery = appliedQuery.trim()
          const response = normalizedQuery
            ? await requestClient.sendRequest('linear.searchIssues', {
                query: normalizedQuery,
                limit: LINEAR_LIMIT,
                workspaceId: selectedLinearWorkspaceId ?? undefined
              })
            : await requestClient.sendRequest('linear.listIssues', {
                filter: linearFilter,
                limit: LINEAR_LIMIT,
                workspaceId: selectedLinearWorkspaceId ?? undefined
              })
          if (!isSuccess(response)) {
            throw new Error(response.error.message)
          }
          const issues = extractLinearIssueReadItems(response.result)
          const filtered =
            selectedLinearTeamIds.size > 0
              ? issues.filter((issue) => selectedLinearTeamIds.has(issue.team.id))
              : issues
          const sorted = [...filtered].sort((a, b) => compareLinearIssues(a, b, linearOrderBy))
          if (!isCurrent()) {
            return
          }
          setItems(sorted.map(createLinearTask))
        }
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setItems([])
        setGithubSourceErrors([])
        setGithubSourceFallbacks([])
        setError(err instanceof Error ? err.message : 'Failed to load tasks')
      } finally {
        if (isCurrent()) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [
      appliedQuery,
      client,
      connState,
      countGitHubItems,
      fetchGitHubItemsPage,
      gitlabFilter,
      gitlabView,
      githubMode,
      linearConnected,
      linearFilter,
      linearOrderBy,
      loadRepos,
      provider,
      selectedLinearTeamIds,
      selectedLinearWorkspaceId,
      selectedRepoIds,
      taskStateHydrated,
      tasksSupported
    ]
  )

  const connectLinearAccount = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !taskUiReady) {
      return
    }
    const apiKey = linearApiKeyDraft.trim()
    if (!apiKey || linearConnectState === 'connecting') {
      return
    }
    setLinearConnectState('connecting')
    setLinearConnectError('')
    try {
      const response = await client.sendRequest('linear.connect', { apiKey })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as { ok?: boolean; error?: string }
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to connect Linear')
      }
      setLinearApiKeyDraft('')
      setLinearConnectState('idle')
      setShowLinearConnect(false)
      setLinearConnected(true)
      setVisibleProviders((current) =>
        current.includes('linear') ? current : [...current, 'linear']
      )
      setProvider('linear')
      await loadLinearContext()
    } catch (err) {
      setLinearConnectState('error')
      setLinearConnectError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [client, connState, linearApiKeyDraft, linearConnectState, loadLinearContext, taskUiReady])

  const retryGitHubIssueSourceFetch = useCallback(
    async (repoPath: string): Promise<void> => {
      setRetryingGithubSourceRepoPaths((current) => {
        const next = new Set(current)
        next.add(repoPath)
        return next
      })
      try {
        // Why: desktop retries through the shared list refresh path so source
        // errors, rows, counts, and pagination reset from one authoritative fetch.
        await loadTasks({ silent: true })
      } finally {
        setRetryingGithubSourceRepoPaths((current) => {
          const next = new Set(current)
          next.delete(repoPath)
          return next
        })
      }
    },
    [loadTasks]
  )

  const githubTotalPages = useMemo(() => {
    const selectedRepoCount = Math.max(1, selectedHostedRepos.length)
    const pageCapacity = Math.max(
      1,
      Math.min(CROSS_REPO_DISPLAY_LIMIT, selectedRepoCount * PER_REPO_FETCH_LIMIT)
    )
    if (githubTotalCount !== null) {
      return Math.max(githubPages.length, Math.ceil(githubTotalCount / pageCapacity))
    }
    return githubPages.length
  }, [githubPages.length, githubTotalCount, selectedHostedRepos.length])
  const githubPageCapacity = useMemo(() => {
    const selectedRepoCount = Math.max(1, selectedHostedRepos.length)
    return Math.max(1, Math.min(CROSS_REPO_DISPLAY_LIMIT, selectedRepoCount * PER_REPO_FETCH_LIMIT))
  }, [selectedHostedRepos.length])
  const githubCanLoadUncountedNextPage =
    githubTotalCount === null && (githubPages.at(-1)?.length ?? 0) >= githubPageCapacity
  const githubCanShowPagination =
    githubTotalPages > 1 || (githubPages.length > 0 && githubCanLoadUncountedNextPage)
  const githubPagePickerPages = useMemo(() => {
    const visible = new Set<number>()
    const availablePages = Math.min(
      githubTotalPages + (githubCanLoadUncountedNextPage ? 1 : 0),
      githubPages.length + (githubCanLoadUncountedNextPage ? 1 : 0)
    )
    for (let index = 0; index < availablePages; index += 1) {
      visible.add(index)
    }
    for (
      let index = Math.max(0, githubCurrentPage - 2);
      index <= Math.min(availablePages - 1, githubCurrentPage + 2);
      index += 1
    ) {
      visible.add(index)
    }
    return [...visible].sort((a, b) => a - b)
  }, [githubCanLoadUncountedNextPage, githubCurrentPage, githubTotalPages])

  const handleGitHubPageChange = useCallback(
    async (targetPage: number): Promise<void> => {
      if (
        !client ||
        !tasksSupported ||
        targetPage < 0 ||
        githubPaginationLoading ||
        selectedHostedRepos.length === 0
      ) {
        return
      }
      if (targetPage > githubPages.length) {
        return
      }
      if (targetPage < githubPages.length) {
        setGithubCurrentPage(targetPage)
        setItems(githubPages[targetPage] ?? [])
        return
      }
      const lastPage = githubPages[githubPages.length - 1]
      const oldestItem = lastPage?.[lastPage.length - 1]
      if (!oldestItem?.updatedAt) {
        return
      }

      setGithubPaginationLoading(true)
      setGithubLoadingTargetPage(targetPage)
      try {
        let cursor = oldestItem.updatedAt
        let loadedPages = githubPages.length
        const nextPages: Array<Extract<TaskItem, { provider: 'github' }>[]> = []
        while (loadedPages <= targetPage) {
          const page = await fetchGitHubItemsPage(client, selectedHostedRepos, cursor)
          if (page.items.length === 0) {
            break
          }
          if (page.failedCount > 0) {
            setError(buildPartialRepositoryNotice(page.failedCount, selectedHostedRepos.length))
          }
          nextPages.push(page.items)
          cursor = page.items[page.items.length - 1]!.updatedAt
          loadedPages += 1
        }
        if (nextPages.length === 0) {
          return
        }
        const allPages = [...githubPages, ...nextPages]
        const nextPage = targetPage < loadedPages ? targetPage : loadedPages - 1
        setGithubPages(allPages)
        setGithubCurrentPage(nextPage)
        setItems(allPages[nextPage] ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load more GitHub tasks')
      } finally {
        setGithubPaginationLoading(false)
        setGithubLoadingTargetPage(null)
      }
    },
    [
      client,
      fetchGitHubItemsPage,
      githubPages,
      githubPaginationLoading,
      selectedHostedRepos,
      tasksSupported
    ]
  )

  const loadGitHubProjects = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    setGithubProjectError('')
    setGithubProjectPartialFailures([])
    const response = await client.sendRequest('github.project.listAccessible', {})
    if (!isSuccess(response)) {
      throw new Error(response.error.message)
    }
    const result = response.result as
      | {
          ok: true
          projects: GitHubProjectSummary[]
          partialFailures?: GitHubProjectPartialFailure[]
        }
      | { ok: false; error: { message: string } }
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    setGithubProjects(result.projects)
    setGithubProjectPartialFailures(result.partialFailures ?? [])
  }, [client, connState, tasksSupported])

  const loadGitHubProjectViews = useCallback(
    async (project: GitHubProjectRef): Promise<GitHubProjectViewSummary[]> => {
      if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
        return []
      }
      const response = await client.sendRequest('github.project.listViews', {
        owner: project.owner,
        ownerType: project.ownerType,
        projectNumber: project.number
      })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as
        | { ok: true; views: GitHubProjectViewSummary[] }
        | { ok: false; error: { message: string } }
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      setGithubProjectViews(result.views)
      return result.views
    },
    [client, connState, taskStateHydrated, tasksSupported]
  )

  const loadGitHubProjectTable = useCallback(
    async (options: { force?: boolean; queryOverride?: string } = {}): Promise<void> => {
      if (
        !client ||
        connState !== 'connected' ||
        !tasksSupported ||
        !activeGitHubProject ||
        !activeGitHubProjectViewId
      ) {
        setGithubProjectTable(null)
        return
      }
      setGithubProjectLoading(true)
      setGithubProjectError('')
      try {
        const response = await client.sendRequest(
          'github.project.viewTable',
          {
            owner: activeGitHubProject.owner,
            ownerType: activeGitHubProject.ownerType,
            projectNumber: activeGitHubProject.number,
            viewId: activeGitHubProjectViewId,
            ...(options.queryOverride !== undefined ? { queryOverride: options.queryOverride } : {})
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; data: GitHubProjectTable }
          | { ok: false; error: { message: string }; totalCount?: number }
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        setGithubProjectTable(result.data)
        setGithubProjectSearch(options.queryOverride ?? result.data.selectedView.filter ?? '')
        setGithubProjectViews((current) =>
          current.some((view) => view.id === result.data.selectedView.id)
            ? current
            : [
                ...current,
                {
                  id: result.data.selectedView.id,
                  number: result.data.selectedView.number,
                  name: result.data.selectedView.name,
                  layout: result.data.selectedView.layout
                }
              ]
        )
      } catch (err) {
        setGithubProjectTable(null)
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to load project view')
      } finally {
        setGithubProjectLoading(false)
      }
    },
    [activeGitHubProject, activeGitHubProjectViewId, client, connState, tasksSupported]
  )

  const commitGitHubProjectView = useCallback(
    (project: GitHubProjectRef, viewId: string): void => {
      const projectKey = githubProjectKey(project)
      const nextSettings: GitHubProjectSettings = {
        ...githubProjectSettings,
        recent: [
          { ...project, lastOpenedAt: new Date().toISOString() },
          ...githubProjectSettings.recent.filter((entry) => githubProjectKey(entry) !== projectKey)
        ].slice(0, 10),
        lastViewByProject: {
          ...githubProjectSettings.lastViewByProject,
          [projectKey]: { viewId }
        },
        activeProject: project
      }
      persistGitHubProjectSettings(nextSettings)
      setAppliedGithubProjectSearch(undefined)
      setGithubProjectSearch('')
      setGithubProjectTable(null)
    },
    [githubProjectSettings, persistGitHubProjectSettings]
  )

  const selectGitHubProject = useCallback(
    async (project: GitHubProjectRef, options: { viewNumber?: number } = {}): Promise<void> => {
      if (!tasksSupported || !taskStateHydrated) {
        return
      }
      setGithubProjectLoading(true)
      setGithubProjectError('')
      try {
        const views = await loadGitHubProjectViews(project)
        const projectKey = githubProjectKey(project)
        const rememberedView = githubProjectSettings.lastViewByProject[projectKey]?.viewId
        const explicitView =
          typeof options.viewNumber === 'number'
            ? views.find((view) => view.number === options.viewNumber)
            : undefined
        if (options.viewNumber !== undefined && !explicitView) {
          // Why: desktop treats stale /views/{n} URLs as a prompt to choose a
          // replacement view, not as a failed project selection.
          const supportedViews = views.filter((view) => view.layout === 'TABLE_LAYOUT')
          if (supportedViews.length === 0) {
            throw new Error('This project has no supported views.')
          }
          setPendingGitHubProjectViewSelection(project)
          setShowGitHubProjectViewPicker(true)
          return
        }
        if (explicitView && explicitView.layout !== 'TABLE_LAYOUT') {
          throw new Error("Orca doesn't support this GitHub Project layout yet.")
        }
        if (!explicitView && !rememberedView) {
          // Why: desktop asks which Project view to open the first time a project
          // is selected. Mobile should not silently choose the first table view.
          const supportedViews = views.filter((view) => view.layout === 'TABLE_LAYOUT')
          if (supportedViews.length === 0) {
            throw new Error('This project has no supported views.')
          }
          setPendingGitHubProjectViewSelection(project)
          setShowGitHubProjectViewPicker(true)
          return
        }
        const selectedView =
          explicitView ??
          views.find((view) => view.id === rememberedView && view.layout === 'TABLE_LAYOUT') ??
          undefined
        if (!selectedView) {
          throw new Error('This project has no supported views.')
        }
        commitGitHubProjectView(project, selectedView.id)
      } catch (err) {
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to select project')
      } finally {
        setGithubProjectLoading(false)
      }
    },
    [
      commitGitHubProjectView,
      githubProjectSettings,
      loadGitHubProjectViews,
      taskStateHydrated,
      tasksSupported
    ]
  )

  const resolveGitHubProjectFromInput = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
      return
    }
    const input = githubProjectPasteInput.trim()
    if (!parseProjectInput(input)) {
      setGithubProjectPasteError('Expected a project URL or owner/number.')
      return
    }
    setGithubProjectPasteBusy(true)
    setGithubProjectPasteError('')
    setGithubProjectError('')
    try {
      const response = await client.sendRequest('github.project.resolveRef', { input })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as
        | {
            ok: true
            owner: string
            ownerType: GitHubProjectOwnerType
            number: number
            title: string
            viewNumber?: number
          }
        | { ok: false; error: { message: string } }
      if (!result.ok) {
        setGithubProjectPasteError(result.error.message)
        return
      }
      setGithubProjectPasteInput('')
      setShowGitHubProjectPicker(false)
      await selectGitHubProject(
        {
          owner: result.owner,
          ownerType: result.ownerType,
          number: result.number
        },
        { viewNumber: result.viewNumber }
      )
    } catch (err) {
      setGithubProjectPasteError(err instanceof Error ? err.message : 'Failed to add project.')
    } finally {
      setGithubProjectPasteBusy(false)
    }
  }, [
    client,
    connState,
    githubProjectPasteInput,
    selectGitHubProject,
    taskStateHydrated,
    tasksSupported
  ])

  useEffect(() => {
    if (!taskStateHydrated) {
      return
    }
    const timer = setTimeout(() => {
      setAppliedQuery(
        provider === 'github' ? scopeGitHubTaskSearch(query, githubKind) : query.trim()
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [githubKind, provider, query, taskStateHydrated])

  const setTaskCopyFeedbackRootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      return
    }
    // Why: copied-link feedback is screen-local; clear the pending reset when
    // the Tasks screen detaches without a passive cleanup-only Effect.
    clearMobileTaskCopyFeedbackTimer(copiedLinkResetTimerRef)
  }, [])

  useEffect(() => {
    if (!taskUiReady || provider !== 'github' || githubMode !== 'items') {
      return
    }
    const trimmed = appliedQuery.trim()
    persistTaskResumeState({
      githubMode: 'items',
      githubItemsPreset: trimmed === getTaskPresetQuery(githubPreset) ? githubPreset : null,
      githubItemsQuery: trimmed
    })
  }, [appliedQuery, githubMode, githubPreset, persistTaskResumeState, provider, taskUiReady])

  useEffect(() => {
    if (!taskUiReady || provider !== 'linear') {
      return
    }
    persistTaskResumeState({
      linearPreset: linearFilter,
      linearQuery: appliedQuery.trim()
    })
  }, [appliedQuery, linearFilter, persistTaskResumeState, provider, taskUiReady])

  useEffect(() => {
    if (connState !== 'connected' || !taskStateHydrated) {
      return
    }
    void loadTasks()
  }, [connState, loadTasks, taskStateHydrated])

  useEffect(() => {
    if (!taskStateHydrated || provider !== 'linear' || !linearConnected) {
      return
    }
    void loadLinearContext().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load Linear context')
    })
  }, [linearConnected, loadLinearContext, provider, taskStateHydrated])

  useEffect(() => {
    if (!taskUiReady || provider !== 'github' || githubMode !== 'project') {
      return
    }
    persistTaskResumeState({ githubMode: 'project' })
    if (activeGitHubProject && activeGitHubProjectViewId) {
      void loadGitHubProjectTable({ queryOverride: appliedGithubProjectSearch })
    } else if (activeGitHubProject) {
      void selectGitHubProject(activeGitHubProject)
    } else {
      void loadGitHubProjects().catch((err) => {
        setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
      })
    }
  }, [
    activeGitHubProject,
    activeGitHubProjectViewId,
    appliedGithubProjectSearch,
    githubMode,
    loadGitHubProjectTable,
    loadGitHubProjects,
    persistTaskResumeState,
    provider,
    selectGitHubProject,
    taskUiReady
  ])

  useEffect(() => {
    if (!taskUiReady || !showGitHubProjectPicker) {
      return
    }
    void loadGitHubProjects().catch((err) => {
      setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
    })
  }, [loadGitHubProjects, showGitHubProjectPicker, taskUiReady])

  useEffect(() => {
    if (!tasksSupported || !taskStateHydrated || !showCreateTask) {
      return
    }
    setCreatingTask(false)
    if (provider === 'github' || provider === 'gitlab') {
      setCreateRepoId((current) =>
        current && hostedRepos.some((repo) => repo.id === current)
          ? current
          : (hostedRepos[0]?.id ?? null)
      )
      return
    }
    if (!client) {
      return
    }
    let stale = false
    setCreateTeamId(null)
    void client
      .sendRequest('linear.listTeams')
      .then((response) => {
        if (stale) {
          return
        }
        if (isSuccess(response)) {
          const teams = response.result as LinearTeam[]
          setLinearTeams(teams)
          setCreateTeamId((current) => current ?? teams[0]?.id ?? null)
        } else {
          setLinearTeams([])
          setCreateTeamId(null)
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearTeams([])
          setCreateTeamId(null)
        }
      })
    return () => {
      stale = true
    }
  }, [client, hostedRepos, provider, showCreateTask, taskStateHydrated, tasksSupported])

  useEffect(() => {
    if (!tasksSupported || !linearMetadataItem || !client) {
      setLinearStates([])
      setLinearCommentDraft('')
      setLinearSubIssueTitle('')
      return
    }
    let stale = false
    setLinearStatesLoading(true)
    setLinearCommentDraft('')
    setLinearSubIssueTitle('')
    const baseParams = {
      teamId: linearMetadataItem.source.team.id,
      workspaceId: linearMetadataItem.source.workspaceId
    }
    void client
      .sendRequest('linear.teamStates', baseParams)
      .then((statesResponse) => {
        if (stale) {
          return
        }
        if (isSuccess(statesResponse)) {
          setLinearStates(statesResponse.result as LinearState[])
        } else {
          setLinearStates([])
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearStates([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLinearStatesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [client, linearMetadataItem, tasksSupported])

  useEffect(() => {
    if (!actionItem) {
      setItemTitleDraft('')
      setItemBodyDraft('')
      setItemCommentDraft('')
      setItemAddLabelsDraft('')
      setItemRemoveLabelsDraft('')
      setItemAddAssigneesDraft('')
      setItemRemoveAssigneesDraft('')
      setItemReviewersDraft('')
      setItemReplyDrafts({})
      setExpandedPrFilePath(null)
      setPrFileContents({})
      setPrFileLoadingPath(null)
      setPrFileCommentDrafts({})
      setExpandedResolvedCommentGroups(new Set())
      return
    }
    setItemTitleDraft(actionItem.title)
    setItemBodyDraft('')
    setItemCommentDraft('')
    setItemAddLabelsDraft('')
    setItemRemoveLabelsDraft('')
    setItemAddAssigneesDraft('')
    setItemRemoveAssigneesDraft('')
    setItemReviewersDraft('')
    setItemReplyDrafts({})
    setExpandedPrFilePath(null)
    setPrFileContents({})
    setPrFileLoadingPath(null)
    setPrFileCommentDrafts({})
    setExpandedResolvedCommentGroups(new Set())
  }, [actionItem])

  useEffect(() => {
    if (!detailPayload) {
      setItemBodyDraft('')
      return
    }
    setItemBodyDraft(
      detailPayload.provider === 'linear' ? detailPayload.description : detailPayload.body
    )
  }, [detailPayload])

  useEffect(() => {
    if (!tasksSupported || !client || actionItem?.provider !== 'github') {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
      setItemAssignableUsers([])
      setItemAssignableUsersLoading(false)
      setItemAssignableUsersError('')
      return
    }

    let stale = false
    if (actionItem.source.type === 'issue' || actionItem.source.type === 'pr') {
      setItemAvailableLabels([])
      setItemLabelsError('')
      setItemLabelsLoading(true)
      void client
        .sendRequest(
          'github.listLabels',
          { repo: `id:${actionItem.source.repoId}` },
          { timeoutMs: 30_000 }
        )
        .then((response) => {
          if (stale) {
            return
          }
          if (!isSuccess(response)) {
            throw new Error(response.error.message)
          }
          setItemAvailableLabels(response.result as string[])
        })
        .catch((err) => {
          if (!stale) {
            setItemLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
          }
        })
        .finally(() => {
          if (!stale) {
            setItemLabelsLoading(false)
          }
        })
    } else {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
    }

    setItemAssignableUsers([])
    setItemAssignableUsersError('')
    setItemAssignableUsersLoading(true)
    void client
      .sendRequest(
        'github.listAssignableUsers',
        { repo: `id:${actionItem.source.repoId}` },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        setItemAssignableUsers(response.result as GitHubAssignableUser[])
      })
      .catch((err) => {
        if (!stale) {
          setItemAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setItemAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, client, tasksSupported])

  useEffect(() => {
    if (!tasksSupported || !actionItem || !client) {
      setDetailPayload(null)
      setDetailLoading(false)
      setDetailError('')
      return
    }

    let stale = false
    setDetailPayload(null)
    setDetailError('')
    setDetailLoading(true)

    const loadDetails = async (): Promise<void> => {
      if (actionItem.provider === 'github') {
        const response = await client.sendRequest(
          'github.workItemDetails',
          {
            repo: `id:${actionItem.source.repoId}`,
            number: actionItem.source.number,
            type: actionItem.source.type
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const details = response.result as {
          body?: string
          comments?: DetailComment[]
          item?: {
            labels?: string[]
            reviewDecision?: string | null
            reviewRequests?: GitHubAssignableUser[]
            latestReviews?: GitHubPRReviewSummary[]
          }
          assignees?: string[]
          headSha?: string
          baseSha?: string
          pullRequestId?: string
          checks?: GitHubDetailCheck[]
          files?: Array<{
            path: string
            oldPath?: string
            status?: GitHubDetailFile['status']
            additions?: number
            deletions?: number
            isBinary?: boolean
            viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
          }>
        } | null
        if (!details) {
          throw new Error('Details not found')
        }
        if (!stale) {
          setDetailPayload({
            provider: 'github',
            body: details.body ?? '',
            comments: details.comments ?? [],
            labels: details.item?.labels ?? actionItem.source.labels,
            assignees: details.assignees ?? [],
            reviewDecision: details.item?.reviewDecision ?? actionItem.source.reviewDecision,
            reviewRequests: details.item?.reviewRequests ?? actionItem.source.reviewRequests ?? [],
            latestReviews: details.item?.latestReviews ?? actionItem.source.latestReviews ?? [],
            headSha: details.headSha,
            baseSha: details.baseSha,
            pullRequestId: details.pullRequestId,
            checks: details.checks ?? [],
            files: details.files ?? []
          })
        }
        return
      }

      if (actionItem.provider === 'gitlab') {
        const response = await client.sendRequest(
          'gitlab.workItemDetails',
          {
            repo: `id:${actionItem.source.repoId}`,
            iid: actionItem.source.number,
            type: actionItem.source.type,
            projectRef: actionItem.source.projectRef
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const details = response.result as {
          body?: string
          comments?: DetailComment[]
          item?: { labels?: string[] }
          assignees?: string[]
          pipelineJobs?: Array<{
            id?: number
            name: string
            stage: string
            status: string
            webUrl?: string | null
            duration?: number | null
          }>
        } | null
        if (!details) {
          throw new Error('Details not found')
        }
        if (!stale) {
          setDetailPayload({
            provider: 'gitlab',
            body: details.body ?? '',
            comments: details.comments ?? [],
            labels: details.item?.labels ?? actionItem.source.labels,
            assignees: details.assignees ?? [],
            pipelineJobs: details.pipelineJobs ?? []
          })
        }
        return
      }

      const [issueResponse, commentsResponse] = await Promise.all([
        client.sendRequest(
          'linear.getIssue',
          {
            id: actionItem.source.id,
            workspaceId: actionItem.source.workspaceId
          },
          { timeoutMs: 30_000 }
        ),
        client.sendRequest(
          'linear.issueComments',
          {
            issueId: actionItem.source.id,
            workspaceId: actionItem.source.workspaceId
          },
          { timeoutMs: 30_000 }
        )
      ])
      if (!isSuccess(issueResponse)) {
        throw new Error(issueResponse.error.message)
      }
      const issue = issueResponse.result as LinearIssue | null
      const comments = isSuccess(commentsResponse)
        ? ((commentsResponse.result as DetailComment[]) ?? [])
        : []
      if (!issue) {
        throw new Error('Details not found')
      }
      if (!stale) {
        setDetailPayload({
          provider: 'linear',
          description: issue.description ?? '',
          comments,
          labels: issue.labels ?? [],
          assignee: issue.assignee?.displayName,
          project: issue.project,
          children: issue.subIssues ?? []
        })
        setActionItem((current) => {
          if (current?.provider !== 'linear' || current.source.id !== issue.id) {
            return current
          }
          const currentChildren = current.source.subIssues ?? []
          const nextChildren = issue.subIssues ?? []
          const alreadyHydrated =
            current.source.project?.id === issue.project?.id &&
            currentChildren.length === nextChildren.length &&
            currentChildren.every((child, index) => child.id === nextChildren[index]?.id)
          return alreadyHydrated
            ? current
            : (createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
        })
      }
    }

    void loadDetails()
      .catch((err) => {
        if (!stale) {
          setDetailError(err instanceof Error ? err.message : 'Failed to load details')
        }
      })
      .finally(() => {
        if (!stale) {
          setDetailLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, client, detailRefreshSeq, tasksSupported])

  useEffect(() => {
    if (!projectRowItem) {
      setProjectRowDetail(null)
      setProjectRowDetailLoading(false)
      setProjectRowDetailError('')
      setProjectTitleDraft('')
      setProjectBodyDraft('')
      setProjectCommentDraft('')
      setProjectEditingCommentId(null)
      setProjectEditingCommentDraft('')
      setProjectReviewersDraft('')
      setExpandedPrFilePath(null)
      setPrFileContents({})
      setPrFileLoadingPath(null)
      setPrFileCommentDrafts({})
      setProjectFieldDrafts({})
      return
    }

    const type = projectRowType(projectRowItem)
    const slug = splitRepositorySlug(projectRowItem.content.repository)
    setProjectTitleDraft(projectRowItem.content.title)
    setProjectBodyDraft(projectRowItem.content.body ?? '')
    setProjectCommentDraft('')
    setProjectEditingCommentId(null)
    setProjectEditingCommentDraft('')
    setProjectReviewersDraft('')
    setExpandedPrFilePath(null)
    setPrFileContents({})
    setPrFileLoadingPath(null)
    setPrFileCommentDrafts({})
    setProjectFieldDrafts(
      Object.fromEntries(
        editableProjectFields(githubProjectTable).map((field) => [
          field.id,
          projectFieldDraftValue(projectRowItem, field)
        ])
      )
    )
    setProjectRowDetail(null)
    setProjectRowDetailError('')

    if (!tasksSupported || !client || !type || !slug || !projectRowItem.content.number) {
      setProjectRowDetailLoading(false)
      return
    }

    let stale = false
    setProjectRowDetailLoading(true)

    void client
      .sendRequest(
        'github.project.workItemDetailsBySlug',
        {
          owner: slug.owner,
          repo: slug.repo,
          number: projectRowItem.content.number,
          type
        },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | {
              ok: true
              details: {
                body?: string
                comments?: DetailComment[]
                item?: {
                  labels?: string[]
                  reviewDecision?: string | null
                  reviewRequests?: GitHubAssignableUser[]
                  latestReviews?: GitHubPRReviewSummary[]
                }
                assignees?: string[]
                headSha?: string
                baseSha?: string
                pullRequestId?: string
                checks?: GitHubDetailCheck[]
                files?: Array<{
                  path: string
                  oldPath?: string
                  status?: GitHubDetailFile['status']
                  additions?: number
                  deletions?: number
                  isBinary?: boolean
                  viewerViewedState?: 'DISMISSED' | 'VIEWED' | 'UNVIEWED'
                }>
              }
            }
          | { ok: false; error: { message: string } }
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        setProjectRowDetail({
          provider: 'github',
          body: result.details.body ?? '',
          comments: result.details.comments ?? [],
          labels: result.details.item?.labels ?? projectRowItem.content.labels.map((l) => l.name),
          assignees: result.details.assignees ?? [],
          reviewDecision: result.details.item?.reviewDecision,
          reviewRequests: result.details.item?.reviewRequests ?? [],
          latestReviews: result.details.item?.latestReviews ?? [],
          headSha: result.details.headSha,
          baseSha: result.details.baseSha,
          pullRequestId: result.details.pullRequestId,
          checks: result.details.checks ?? [],
          files: result.details.files ?? []
        })
      })
      .catch((err) => {
        if (!stale) {
          setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to load details')
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectRowDetailLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [client, githubProjectTable, projectRowDetailRefreshSeq, projectRowItem, tasksSupported])

  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectAvailableLabels([])
      setProjectLabelsLoading(false)
      setProjectLabelsError('')
      return
    }

    let stale = false
    setProjectAvailableLabels([])
    setProjectLabelsError('')
    setProjectLabelsLoading(true)
    void client
      .sendRequest(
        'github.project.listLabelsBySlug',
        { owner: slug.owner, repo: slug.repo },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; labels?: string[] }
          | { ok: false; error?: { message?: string } }
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load labels')
        }
        setProjectAvailableLabels(result.labels ?? [])
      })
      .catch((err) => {
        if (!stale) {
          setProjectLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectLabelsLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [client, projectMetadataRepository, tasksSupported])

  useEffect(() => {
    const slug = splitRepositorySlug(projectMetadataRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectAssignableUsers([])
      setProjectAssignableUsersLoading(false)
      setProjectAssignableUsersError('')
      return
    }

    let stale = false
    setProjectAssignableUsers([])
    setProjectAssignableUsersError('')
    setProjectAssignableUsersLoading(true)
    void client
      .sendRequest(
        'github.project.listAssignableUsersBySlug',
        {
          owner: slug.owner,
          repo: slug.repo,
          ...(projectMetadataSeedLogins ? { seedLogins: projectMetadataSeedLogins.split(',') } : {})
        },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; users?: GitHubAssignableUser[] }
          | { ok: false; error?: { message?: string } }
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load assignees')
        }
        setProjectAssignableUsers(result.users ?? [])
      })
      .catch((err) => {
        if (!stale) {
          setProjectAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [client, projectMetadataRepository, projectMetadataSeedLogins, tasksSupported])

  useEffect(() => {
    const slug = splitRepositorySlug(projectIssueTypeRepository)
    if (!tasksSupported || !client || !slug) {
      setProjectIssueTypes([])
      setProjectIssueTypesLoading(false)
      setProjectIssueTypesError('')
      return
    }

    let stale = false
    setProjectIssueTypes([])
    setProjectIssueTypesError('')
    setProjectIssueTypesLoading(true)
    void client
      .sendRequest(
        'github.project.listIssueTypesBySlug',
        { owner: slug.owner, repo: slug.repo },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; types?: GitHubIssueType[] }
          | { ok: false; error?: { message?: string } }
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to load issue types')
        }
        setProjectIssueTypes(result.types ?? [])
      })
      .catch((err) => {
        if (!stale) {
          setProjectIssueTypesError(
            err instanceof Error ? err.message : 'Failed to load issue types'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setProjectIssueTypesLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [client, projectIssueTypeRepository, tasksSupported])

  const getWorkspaceTargetRepo = useCallback(
    (item: ActionableTaskItem, repoIdOverride?: string): RepoSummary | null => {
      if (item.provider === 'github' || item.provider === 'gitlab') {
        return repos.find((entry) => entry.id === item.source.repoId) ?? null
      }
      if (repoIdOverride) {
        return workspaceRepos.find((entry) => entry.id === repoIdOverride) ?? null
      }
      return workspaceRepos[0] ?? null
    },
    [repos, workspaceRepos]
  )

  const workspaceCreateTargetRepo = useMemo(
    () =>
      workspaceCreateDraft
        ? getWorkspaceTargetRepo(workspaceCreateDraft.item, workspaceCreateDraft.repoIdOverride)
        : null,
    [getWorkspaceTargetRepo, workspaceCreateDraft]
  )
  const workspaceCreateTargetConnectionId = workspaceCreateTargetRepo?.connectionId ?? null
  const workspaceCreateSshGate = deriveWorkspaceSshGate({
    connectionId: workspaceCreateTargetConnectionId,
    state: workspaceSshState,
    connecting: workspaceSshConnecting
  })
  const workspaceCreateSshStatus = workspaceCreateSshGate.status
  const workspaceCreateRequiresSshConnection = workspaceCreateSshGate.requiresConnection
  const workspaceCreateSshConnectInProgress = workspaceCreateSshGate.connectInProgress
  const workspaceCreateSshError = workspaceCreateSshGate.error
  const workspaceCreateCanPickRepo =
    workspaceCreateDraft?.item.provider === 'linear' && workspaceRepos.length > 1
  const workspaceSparseCheckoutAvailable =
    workspaceCreateTargetRepo != null && !workspaceCreateTargetRepo.connectionId
  const workspaceSparseDraftParsed = useMemo(
    () =>
      workspaceSparseDraft
        ? parseSparsePresetDirectories(workspaceSparseDraft.directoriesText)
        : null,
    [workspaceSparseDraft]
  )
  const workspaceSparseDraftName = workspaceSparseDraft?.name.trim() ?? ''
  const workspaceSparseDraftNameCollision =
    workspaceSparseDraft && workspaceSparseDraftName
      ? (workspaceSparsePresets.find(
          (preset) =>
            preset.id !== workspaceSparseDraft.presetId &&
            preset.name.toLowerCase() === workspaceSparseDraftName.toLowerCase()
        ) ?? null)
      : null
  const workspaceSparseDraftError =
    workspaceSparseDraft && workspaceSparseDraftName.length === 0
      ? 'Name is required.'
      : workspaceSparseDraftName.length > 80
        ? 'Name must be 80 characters or fewer.'
        : workspaceSparseDraftNameCollision
          ? `"${workspaceSparseDraftNameCollision.name}" already exists.`
          : (workspaceSparseDraftParsed?.error ?? null)
  const canSaveWorkspaceSparseDraft =
    workspaceSparseDraft !== null &&
    workspaceCreateTargetRepo !== null &&
    workspaceSparseCheckoutAvailable &&
    workspaceSparsePresetsLoaded &&
    !workspaceSparsePresetsLoading &&
    !workspaceSparseSaving &&
    !workspaceSparseDraftError &&
    workspaceSparseDraftParsed !== null

  const workspaceAgentOptions = useMemo<PickerOption<WorkspaceAgentChoice>[]>(() => {
    const enabledAgents = filterWorkspaceAgents(
      MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
      runtimeTaskSettings.disabledTuiAgents
    )
    const availableAgents =
      workspaceDetectedAgentIds === null
        ? new Set<TuiAgent>(enabledAgents)
        : new Set<TuiAgent>(enabledAgents.filter((agent) => workspaceDetectedAgentIds.has(agent)))
    if (
      workspaceAgent &&
      workspaceAgent !== 'blank' &&
      isWorkspaceAgentEnabled(workspaceAgent, runtimeTaskSettings.disabledTuiAgents) &&
      (workspaceDetectedAgentIds === null || workspaceDetectedAgentIds.has(workspaceAgent))
    ) {
      availableAgents.add(workspaceAgent)
    }
    const agents = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => availableAgents.has(agent))
    return [
      ...agents.map((agent) => ({
        value: agent,
        label: workspaceAgentLabel(agent),
        subtitle: agent,
        renderIcon: () => <MobileAgentIcon agentId={workspaceAgentIconId(agent)} size={18} />
      })),
      {
        value: 'blank' as const,
        label: workspaceAgentLabel('blank'),
        subtitle: 'Open a shell',
        renderIcon: () => <MobileAgentIcon agentId="__blank__" size={18} />
      }
    ]
  }, [runtimeTaskSettings.disabledTuiAgents, workspaceAgent, workspaceDetectedAgentIds])
  const openWorkspaceCreate = useCallback((item: ActionableTaskItem, repoIdOverride?: string) => {
    const suggestedName = taskWorkspaceSuggestedName(item)
    setWorkspaceCreateDraft({ item, ...(repoIdOverride ? { repoIdOverride } : {}) })
    setWorkspaceNameDraft(suggestedName)
    setWorkspaceLastAutoName(suggestedName)
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setWorkspaceBaseBranch(null)
    setWorkspaceBaseBranchQuery('')
    setWorkspaceBaseBranchResults([])
    setWorkspaceBaseBranchLoading(false)
    setWorkspaceBaseBranchError('')
    setWorkspaceSparsePresetId(null)
    setWorkspaceSparsePresets([])
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    setWorkspaceSparseReloadKey(0)
    setWorkspaceSparseDraft(null)
    setWorkspaceSparseSaving(false)
    setWorkspaceAgentOverridden(false)
    setWorkspaceAgent(null)
    setOrcaYamlTrustPrompt(null)
    setShowWorkspaceAgentPicker(false)
    setShowWorkspaceCreateRepoPicker(false)
    setShowWorkspaceAdvanced(false)
    setShowWorkspaceBaseBranchPicker(false)
    setShowWorkspaceSparsePicker(false)
    setError('')
  }, [])

  const handleWorkspaceNameDraftChange = useCallback(
    (nextName: string): void => {
      if (!nextName.trim()) {
        setWorkspaceLastAutoName('')
      } else if (workspaceNameDraft !== workspaceLastAutoName) {
        setWorkspaceLastAutoName('')
      }
      if (workspaceBranchNameOverride && nextName !== workspaceBranchAutoName) {
        setWorkspaceBranchNameOverride(undefined)
        setWorkspaceBranchAutoName('')
      }
      setWorkspaceNameDraft(nextName)
    },
    [
      workspaceBranchAutoName,
      workspaceBranchNameOverride,
      workspaceLastAutoName,
      workspaceNameDraft
    ]
  )

  const selectWorkspaceBaseBranch = useCallback(
    (branch: BaseRefSearchResult): void => {
      const selection = resolveComposerBranchSelection({
        refName: branch.refName,
        localBranchName: branch.localBranchName,
        currentName: workspaceNameDraft,
        lastAutoName: workspaceLastAutoName
      })
      setWorkspaceBaseBranch(branch)
      setWorkspaceBranchAutoName(selection.branchAutoName)
      setWorkspaceBranchNameOverride(selection.branchNameOverride)
      if (selection.name !== undefined && selection.lastAutoName !== undefined) {
        setWorkspaceNameDraft(selection.name)
        setWorkspaceLastAutoName(selection.lastAutoName)
      }
      setShowWorkspaceBaseBranchPicker(false)
    },
    [workspaceLastAutoName, workspaceNameDraft]
  )

  const clearWorkspaceBaseBranch = useCallback((): void => {
    setWorkspaceBaseBranch(null)
    setWorkspaceBranchAutoName('')
    setWorkspaceBranchNameOverride(undefined)
    setShowWorkspaceBaseBranchPicker(false)
  }, [])

  useEffect(() => {
    if (!tasksSupported || !client || !workspaceCreateDraft || !workspaceCreateTargetRepo) {
      setWorkspaceSparsePresets([])
      setWorkspaceSparsePresetsLoading(false)
      setWorkspaceSparsePresetsLoaded(false)
      setWorkspaceSparsePresetsError('')
      setWorkspaceSparsePresetId(null)
      setWorkspaceSparseDraft(null)
      return
    }
    if (workspaceCreateTargetRepo.connectionId) {
      setWorkspaceSparsePresets([])
      setWorkspaceSparsePresetsLoading(false)
      setWorkspaceSparsePresetsLoaded(false)
      setWorkspaceSparsePresetsError('')
      setWorkspaceSparsePresetId(null)
      setWorkspaceSparseDraft(null)
      return
    }

    let stale = false
    setWorkspaceSparsePresetsLoading(true)
    setWorkspaceSparsePresetsLoaded(false)
    setWorkspaceSparsePresetsError('')
    void client
      .sendRequest('repo.sparsePresets', { repo: `id:${workspaceCreateTargetRepo.id}` })
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const presets = (response.result as { presets?: SparsePreset[] }).presets ?? []
        setWorkspaceSparsePresets(presets)
        setWorkspaceSparsePresetsLoaded(true)
        setWorkspaceSparsePresetId((current) =>
          current && presets.some((preset) => preset.id === current) ? current : null
        )
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceSparsePresets([])
          setWorkspaceSparsePresetsLoaded(false)
          setWorkspaceSparsePresetId(null)
          setWorkspaceSparsePresetsError(
            err instanceof Error ? err.message : 'Failed to load sparse presets.'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setWorkspaceSparsePresetsLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateTargetRepo,
    workspaceSparseReloadKey
  ])

  useEffect(() => {
    if (
      !client ||
      !tasksSupported ||
      !workspaceCreateDraft ||
      !workspaceCreateTargetRepo ||
      !showWorkspaceBaseBranchPicker
    ) {
      setWorkspaceBaseBranchResults([])
      setWorkspaceBaseBranchLoading(false)
      setWorkspaceBaseBranchError('')
      return
    }
    const query = workspaceBaseBranchQuery.trim()
    if (!query) {
      setWorkspaceBaseBranchResults([])
      setWorkspaceBaseBranchLoading(false)
      setWorkspaceBaseBranchError('')
      return
    }

    let stale = false
    setWorkspaceBaseBranchLoading(true)
    setWorkspaceBaseBranchError('')
    void client
      .sendRequest(
        'repo.searchRefs',
        { repo: `id:${workspaceCreateTargetRepo.id}`, query, limit: 20 },
        { timeoutMs: 30_000 }
      )
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          refDetails?: BaseRefSearchResult[]
          refs?: string[]
        }
        setWorkspaceBaseBranchResults(
          result.refDetails ??
            (result.refs ?? []).map((refName) => ({ refName, localBranchName: refName }))
        )
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceBaseBranchResults([])
          setWorkspaceBaseBranchError(
            err instanceof Error ? err.message : 'Failed to search branches.'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setWorkspaceBaseBranchLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    showWorkspaceBaseBranchPicker,
    workspaceBaseBranchQuery,
    workspaceCreateDraft,
    workspaceCreateTargetRepo
  ])

  const startNewWorkspaceSparsePreset = useCallback(() => {
    if (
      !workspaceSparseCheckoutAvailable ||
      !workspaceSparsePresetsLoaded ||
      workspaceSparsePresetsLoading
    ) {
      return
    }
    setWorkspaceSparseDraft({ mode: 'new', name: '', directoriesText: '' })
    setShowWorkspaceSparsePicker(false)
  }, [
    workspaceSparseCheckoutAvailable,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading
  ])

  const startEditWorkspaceSparsePreset = useCallback(
    (preset: SparsePreset) => {
      if (
        !workspaceSparseCheckoutAvailable ||
        !workspaceSparsePresetsLoaded ||
        workspaceSparsePresetsLoading
      ) {
        return
      }
      setWorkspaceSparseDraft({
        mode: 'edit',
        presetId: preset.id,
        name: preset.name,
        directoriesText: preset.directories.join('\n')
      })
      setShowWorkspaceSparsePicker(false)
    },
    [workspaceSparseCheckoutAvailable, workspaceSparsePresetsLoaded, workspaceSparsePresetsLoading]
  )

  const saveWorkspaceSparsePreset = useCallback(async (): Promise<void> => {
    if (
      !client ||
      !tasksSupported ||
      !workspaceCreateTargetRepo ||
      !workspaceSparseDraft ||
      !workspaceSparseDraftParsed ||
      !canSaveWorkspaceSparseDraft
    ) {
      return
    }
    setWorkspaceSparseSaving(true)
    setWorkspaceSparsePresetsError('')
    try {
      const response = await client.sendRequest('repo.saveSparsePreset', {
        repo: `id:${workspaceCreateTargetRepo.id}`,
        ...(workspaceSparseDraft.presetId ? { id: workspaceSparseDraft.presetId } : {}),
        name: workspaceSparseDraftName,
        directories: workspaceSparseDraftParsed.directories
      })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const saved = (response.result as { preset?: SparsePreset }).preset
      if (!saved) {
        throw new Error('Failed to save sparse preset.')
      }
      setWorkspaceSparsePresets((current) => {
        const withoutSaved = current.filter((preset) => preset.id !== saved.id)
        return sortSparsePresetsByName([...withoutSaved, saved])
      })
      setWorkspaceSparsePresetsLoaded(true)
      if (workspaceSparseDraft.mode === 'new' || workspaceSparsePresetId === saved.id) {
        setWorkspaceSparsePresetId(saved.id)
      }
      setWorkspaceSparseDraft(null)
    } catch (err) {
      setWorkspaceSparsePresetsError(
        err instanceof Error ? err.message : 'Failed to save sparse preset.'
      )
    } finally {
      setWorkspaceSparseSaving(false)
    }
  }, [
    canSaveWorkspaceSparseDraft,
    client,
    tasksSupported,
    workspaceCreateTargetRepo,
    workspaceSparseDraft,
    workspaceSparseDraftName,
    workspaceSparseDraftParsed,
    workspaceSparsePresetId
  ])

  useEffect(() => {
    if (!tasksSupported || !client || !workspaceCreateDraft || !workspaceCreateTargetConnectionId) {
      setWorkspaceSshState(null)
      setWorkspaceSshConnecting(false)
      return
    }

    let stale = false
    void client
      .sendRequest('ssh.getState', { targetId: workspaceCreateTargetConnectionId })
      .then((response) => {
        if (stale) {
          return
        }
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const state = (response.result as { state?: SshConnectionState | null }).state ?? null
        setWorkspaceSshState(
          state ?? {
            targetId: workspaceCreateTargetConnectionId,
            status: 'disconnected',
            error: null,
            reconnectAttempt: 0
          }
        )
      })
      .catch((err) => {
        if (!stale) {
          setWorkspaceSshState({
            targetId: workspaceCreateTargetConnectionId,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to read SSH connection state.',
            reconnectAttempt: 0
          })
        }
      })

    return () => {
      stale = true
    }
  }, [client, tasksSupported, workspaceCreateDraft, workspaceCreateTargetConnectionId])

  const connectWorkspaceSshRepo = useCallback(async (): Promise<void> => {
    if (!client || !tasksSupported || !workspaceCreateTargetConnectionId) {
      return
    }
    setWorkspaceSshConnecting(true)
    setWorkspaceSshState({
      targetId: workspaceCreateTargetConnectionId,
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    })
    try {
      const response = await client.sendRequest(
        'ssh.connect',
        { targetId: workspaceCreateTargetConnectionId },
        { timeoutMs: 120_000 }
      )
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const state = (response.result as { state?: SshConnectionState | null }).state
      setWorkspaceSshState(
        state ?? {
          targetId: workspaceCreateTargetConnectionId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        }
      )
    } catch (err) {
      setWorkspaceSshState({
        targetId: workspaceCreateTargetConnectionId,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to connect to SSH repository.',
        reconnectAttempt: 0
      })
    } finally {
      setWorkspaceSshConnecting(false)
    }
  }, [client, tasksSupported, workspaceCreateTargetConnectionId])

  const ensureWorkspaceSshReady = useCallback(
    async (repo: RepoSummary): Promise<void> => {
      if (!repo.connectionId || !client || !tasksSupported) {
        return
      }
      if (
        workspaceSshState?.targetId === repo.connectionId &&
        workspaceSshState.status === 'connected'
      ) {
        return
      }
      const response = await client.sendRequest('ssh.getState', { targetId: repo.connectionId })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const state = (response.result as { state?: SshConnectionState | null }).state ?? null
      if (state) {
        setWorkspaceSshState(state)
      }
      if (state?.status !== 'connected') {
        throw new Error(`Connect ${repo.displayName} before creating a workspace.`)
      }
    },
    [client, tasksSupported, workspaceSshState]
  )

  useEffect(() => {
    if (!tasksSupported || !workspaceCreateDraft || !client || !workspaceCreateTargetRepo) {
      setWorkspaceDetectedAgentIds(null)
      return
    }
    if (workspaceCreateTargetRepo.connectionId && workspaceCreateSshStatus !== 'connected') {
      // Why: remote agent detection runs on the SSH host through the relay; a
      // disconnected repo would fail and cache an empty agent list.
      setWorkspaceDetectedAgentIds(null)
      return
    }
    let stale = false
    setWorkspaceDetectedAgentIds(null)
    const request = workspaceCreateTargetRepo.connectionId
      ? client.sendRequest('preflight.detectRemoteAgents', {
          connectionId: workspaceCreateTargetRepo.connectionId
        })
      : client.sendRequest('preflight.detectAgents')
    void request
      .then((response) => {
        if (stale) {
          return
        }
        setWorkspaceDetectedAgentIds(
          isSuccess(response) ? new Set(response.result as string[]) : new Set()
        )
      })
      .catch(() => {
        if (!stale) {
          setWorkspaceDetectedAgentIds(new Set())
        }
      })
    return () => {
      stale = true
    }
  }, [
    client,
    tasksSupported,
    workspaceCreateDraft,
    workspaceCreateSshStatus,
    workspaceCreateTargetRepo
  ])

  const workspaceAgentSelection = resolveWorkspaceAgentSelection({
    selectionActive: tasksSupported && workspaceCreateDraft !== null,
    settings: runtimeTaskSettings,
    detectedAgentIds: workspaceDetectedAgentIds,
    agent: workspaceAgent,
    overridden: workspaceAgentOverridden
  })
  if (
    workspaceAgentSelection.agent !== workspaceAgent ||
    workspaceAgentSelection.overridden !== workspaceAgentOverridden
  ) {
    // Why: the drawer can open before SSH/local detection settles. Resolve the
    // visible agent before commit so users do not see an unavailable override.
    setWorkspaceAgent(workspaceAgentSelection.agent)
    setWorkspaceAgentOverridden(workspaceAgentSelection.overridden)
  }

  const resolvedWorkspaceAgent = useMemo(
    () => workspaceAgent ?? pickWorkspaceAgent(runtimeTaskSettings, workspaceDetectedAgentIds),
    [runtimeTaskSettings, workspaceAgent, workspaceDetectedAgentIds]
  )
  const workspaceAgentDetectionPending =
    workspaceCreateDraft != null &&
    workspaceCreateTargetRepo != null &&
    !workspaceCreateRequiresSshConnection &&
    workspaceDetectedAgentIds === null

  const resolveCreateSetupDecision = useCallback(
    async (
      repo: RepoSummary,
      override?: Exclude<SetupDecision, 'inherit'>
    ): Promise<
      | { kind: 'decision'; decision: SetupDecision; setupTrust?: RepoHooksResponse['setupTrust'] }
      | {
          kind: 'prompt'
          command: string
          source: string | null
          setupTrust?: RepoHooksResponse['setupTrust']
        }
    > => {
      if (!client || !tasksSupported) {
        return { kind: 'decision', decision: override ?? 'inherit' }
      }
      const response = await client.sendRequest('repo.hooks', { repo: `id:${repo.id}` })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as RepoHooksResponse
      const setupCommand = result.hooks?.scripts?.setup?.trim()
      const setupTrust = normalizeSetupHookTrust(result.setupTrust) ?? undefined
      if (!setupCommand) {
        return { kind: 'decision', decision: 'inherit' }
      }
      if (override) {
        return { kind: 'decision', decision: override, setupTrust }
      }
      const setupRunPolicy = result.setupRunPolicy ?? 'run-by-default'
      if (setupRunPolicy === 'ask') {
        return { kind: 'prompt', command: setupCommand, source: result.source, setupTrust }
      }
      return {
        kind: 'decision',
        decision: setupRunPolicy === 'run-by-default' ? 'run' : 'skip',
        setupTrust
      }
    },
    [client, tasksSupported]
  )

  const createWorkspace = useCallback(
    async (
      item: ActionableTaskItem,
      repoIdOverride?: string,
      setupOverride?: Exclude<SetupDecision, 'inherit'>,
      agentOverride?: WorkspaceAgentChoice,
      workspaceNameOverride?: string,
      noteOverride?: string,
      baseBranchOverride?: string,
      branchNameOverride?: string,
      sparseCheckoutOverride?: { directories: string[]; presetId?: string },
      approvedSetupContentHash?: string
    ): Promise<void> => {
      if (!client || !tasksSupported || !taskStateHydrated) {
        return
      }
      setCreatingKey(item.key)
      setError('')
      try {
        const targetRepo = getWorkspaceTargetRepo(item, repoIdOverride)
        if (!targetRepo) {
          throw new Error(
            item.provider === 'linear'
              ? 'Add a Git repository before creating a Linear workspace.'
              : 'Repository not found.'
          )
        }
        await ensureWorkspaceSshReady(targetRepo)
        let latestRuntimeTaskSettings = runtimeTaskSettings
        try {
          const settingsResponse = await client.sendRequest('settings.get')
          if (isSuccess(settingsResponse)) {
            latestRuntimeTaskSettings = ((
              settingsResponse.result as { settings?: RuntimeTaskSettings }
            ).settings ?? {}) as RuntimeTaskSettings
            setRuntimeTaskSettings(latestRuntimeTaskSettings)
          }
        } catch {
          // Best-effort refresh; the runtime still validates agent availability before spawning.
        }
        const selectedAgent =
          agentOverride &&
          (agentOverride === 'blank' ||
            isWorkspaceAgentEnabled(agentOverride, latestRuntimeTaskSettings.disabledTuiAgents))
            ? agentOverride
            : pickWorkspaceAgent(latestRuntimeTaskSettings, workspaceDetectedAgentIds)
        if (
          agentOverride &&
          agentOverride !== 'blank' &&
          !isWorkspaceAgentEnabled(agentOverride, latestRuntimeTaskSettings.disabledTuiAgents)
        ) {
          setWorkspaceAgent(selectedAgent)
          setWorkspaceAgentOverridden(false)
          throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
        }
        const setupResolution = await resolveCreateSetupDecision(targetRepo, setupOverride)
        const comment = noteOverride?.trim()
        if (setupResolution.kind === 'prompt') {
          // Why: desktop does not silently create when a repo policy says setup
          // requires a per-workspace decision. Mobile must ask before create too.
          setSetupPrompt({
            item,
            ...(repoIdOverride ? { repoIdOverride } : {}),
            ...(agentOverride ? { agentOverride } : {}),
            ...(workspaceNameOverride ? { workspaceNameOverride } : {}),
            ...(comment ? { noteOverride: comment } : {}),
            ...(baseBranchOverride ? { baseBranchOverride } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            ...(sparseCheckoutOverride ? { sparseCheckoutOverride } : {}),
            repoName: targetRepo.displayName,
            command: setupResolution.command,
            source: setupResolution.source
          })
          return
        }
        const setupDecision = setupResolution.decision
        if (
          setupDecision === 'run' &&
          setupResolution.setupTrust &&
          setupResolution.setupTrust.contentHash !== approvedSetupContentHash &&
          !isSetupHookTrusted(
            trustedOrcaHooks,
            targetRepo.id,
            setupResolution.setupTrust.contentHash
          )
        ) {
          // Why: desktop prompts before running repo-owned orca.yaml hooks. Mobile
          // stores the same trust hash in persisted UI state so either surface can
          // approve the script version for future workspace creates.
          setSetupPrompt(null)
          setOrcaYamlTrustPrompt({
            item,
            ...(repoIdOverride ? { repoIdOverride } : {}),
            setupOverride: 'run',
            ...(agentOverride ? { agentOverride } : {}),
            ...(workspaceNameOverride ? { workspaceNameOverride } : {}),
            ...(comment ? { noteOverride: comment } : {}),
            ...(baseBranchOverride ? { baseBranchOverride } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            ...(sparseCheckoutOverride ? { sparseCheckoutOverride } : {}),
            repoId: targetRepo.id,
            repoName: targetRepo.displayName,
            scriptContent: setupResolution.setupTrust.scriptContent,
            contentHash: setupResolution.setupTrust.contentHash,
            previouslyApproved: wasSetupHookPreviouslyApproved(trustedOrcaHooks, targetRepo.id)
          })
          return
        }
        let params: Record<string, unknown>
        if (item.provider === 'github') {
          const source = item.source
          let prStartPoint: { baseBranch: string; pushTarget?: GitPushTarget } | undefined
          if (
            shouldResolveHostedReviewStartPoint({
              type: source.type,
              baseBranchOverride
            })
          ) {
            const response = await client.sendRequest(
              'worktree.resolvePrBase',
              {
                repo: `id:${source.repoId}`,
                prNumber: source.number,
                ...(source.branchName ? { headRefName: source.branchName } : {}),
                ...(source.isCrossRepository !== undefined
                  ? { isCrossRepository: source.isCrossRepository }
                  : {})
              },
              { timeoutMs: 30_000 }
            )
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            const result = response.result as
              | { baseBranch: string; pushTarget?: GitPushTarget }
              | { error: string }
            if ('error' in result) {
              throw new Error(result.error)
            }
            prStartPoint = result
          }
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride,
            hostedStartPoint: prStartPoint
          })
        } else if (item.provider === 'gitlab') {
          const source = item.source
          let mrStartPoint: { baseBranch: string; pushTarget?: GitPushTarget } | undefined
          if (
            shouldResolveHostedReviewStartPoint({
              type: source.type,
              baseBranchOverride
            })
          ) {
            const response = await client.sendRequest(
              'worktree.resolveMrBase',
              {
                repo: `id:${source.repoId}`,
                mrIid: source.number,
                ...(source.branchName ? { sourceBranch: source.branchName } : {}),
                ...(source.isCrossRepository !== undefined
                  ? { isCrossRepository: source.isCrossRepository }
                  : {})
              },
              { timeoutMs: 30_000 }
            )
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            const result = response.result as
              | { baseBranch: string; pushTarget?: GitPushTarget }
              | { error: string }
            if ('error' in result) {
              throw new Error(result.error)
            }
            mrStartPoint = result
          }
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride,
            hostedStartPoint: mrStartPoint
          })
        } else {
          params = buildTaskWorkspaceCreateParams({
            item,
            targetRepoId: targetRepo.id,
            setupDecision,
            agent: selectedAgent,
            workspaceName: workspaceNameOverride,
            note: comment,
            baseBranch: baseBranchOverride,
            branchNameOverride,
            sparseCheckout: sparseCheckoutOverride
          })
        }
        const response = await client.sendRequest('worktree.create', params, {
          timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
        })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          worktree: { id: string; displayName?: string }
          warning?: string
        }
        setActionItem(null)
        setWorkspaceCreateDraft(null)
        setSetupPrompt(null)
        const name = result.worktree.displayName ?? item.title
        const queryParams = new URLSearchParams({ name, created: '1' })
        if (result.warning) {
          queryParams.set('warning', result.warning)
        }
        router.push(
          `/h/${hostId}/session/${encodeURIComponent(result.worktree.id)}?${queryParams.toString()}`
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create workspace')
      } finally {
        setCreatingKey(null)
      }
    },
    [
      client,
      ensureWorkspaceSshReady,
      getWorkspaceTargetRepo,
      hostId,
      resolveCreateSetupDecision,
      router,
      runtimeTaskSettings,
      taskStateHydrated,
      tasksSupported,
      trustedOrcaHooks,
      workspaceDetectedAgentIds
    ]
  )

  const createWorkspaceFromProjectRow = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!tasksSupported) {
        return
      }
      const kind = projectRowType(row)
      const repo = findProjectRowRepo(row)
      if (!kind || !row.content.number || !row.content.url) {
        setError('Add the project item repository to Orca before creating a workspace.')
        return
      }
      if (!repo) {
        const slug = splitRepositorySlug(row.content.repository)
        setProjectRepoNotInOrca({
          owner: slug?.owner ?? 'Unknown',
          repo: slug?.repo ?? row.content.repository ?? 'repository',
          url: row.content.url ?? null
        })
        return
      }
      const state: GitHubWorkItem['state'] =
        row.content.state === 'MERGED'
          ? 'merged'
          : row.content.state === 'CLOSED'
            ? 'closed'
            : row.content.isDraft
              ? 'draft'
              : 'open'
      const source: GitHubWorkItem = {
        id: row.id,
        type: kind,
        number: row.content.number,
        title: row.content.title,
        state,
        url: row.content.url,
        labels: row.content.labels.map((label) => label.name),
        updatedAt: row.updatedAt,
        author: null,
        repoId: repo.id,
        repoName: repo.displayName
      }
      openWorkspaceCreate({
        key: `github-project:${row.id}`,
        provider: 'github',
        title: row.content.title,
        subtitle: `${repo.displayName} #${row.content.number}`,
        status: projectRowStatusLabel(row),
        updatedAt: row.updatedAt,
        source
      })
    },
    [findProjectRowRepo, openWorkspaceCreate, tasksSupported]
  )

  const mutateProjectRowIssueOrPr = useCallback(
    async (
      row: GitHubProjectRow,
      updates: { title?: string; body?: string; state?: 'open' | 'closed' }
    ): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const type = projectRowType(row)
      const slug = splitRepositorySlug(row.content.repository)
      if (!type || !slug || !row.content.number) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          type === 'issue'
            ? 'github.project.updateIssueBySlug'
            : 'github.project.updatePullRequestBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            number: row.content.number,
            updates
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')
        }
        setProjectRowItem((current) => {
          if (!current || current.id !== row.id) {
            return current
          }
          return {
            ...current,
            content: {
              ...current.content,
              ...(updates.title !== undefined ? { title: updates.title } : {}),
              ...(updates.body !== undefined ? { body: updates.body } : {}),
              ...(updates.state !== undefined
                ? { state: updates.state === 'closed' ? 'CLOSED' : 'OPEN' }
                : {})
            }
          }
        })
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id
                    ? {
                        ...candidate,
                        content: {
                          ...candidate.content,
                          ...(updates.title !== undefined ? { title: updates.title } : {}),
                          ...(updates.body !== undefined ? { body: updates.body } : {}),
                          ...(updates.state !== undefined
                            ? { state: updates.state === 'closed' ? 'CLOSED' : 'OPEN' }
                            : {})
                        }
                      }
                    : candidate
                )
              }
            : table
        )
        if (updates.body !== undefined) {
          setProjectRowDetail((current) =>
            current?.provider === 'github' ? { ...current, body: updates.body ?? '' } : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update item')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectMutating]
  )

  const addProjectRowComment = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const body = projectCommentDraft.trim()
      if (!slug || !row.content.number || !body) {
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          'github.project.addIssueCommentBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            number: row.content.number,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as
          | { ok: true; comment?: DetailComment }
          | { ok: false; error?: { message?: string } }
        if (!result.ok) {
          throw new Error(result.error?.message ?? 'Failed to add comment')
        }
        setProjectCommentDraft('')
        if (result.comment) {
          setProjectRowDetail((current) =>
            current?.provider === 'github'
              ? { ...current, comments: [...current.comments, result.comment as DetailComment] }
              : current
          )
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectCommentDraft, projectMutating]
  )

  const updateProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const commentId = Number(comment.id)
      const body = projectEditingCommentDraft.trim()
      if (!slug || !Number.isInteger(commentId) || commentId <= 0 || !body) {
        setProjectRowDetailError('This project comment cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.project.updateIssueCommentBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            commentId,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string | { message?: string }
        }
        if (result.ok === false) {
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : (result.error?.message ?? 'Failed to edit comment')
          )
        }
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  Number(candidate.id) === commentId ? { ...candidate, body } : candidate
                )
              }
            : current
        )
        setProjectEditingCommentId(null)
        setProjectEditingCommentDraft('')
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to edit comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectEditingCommentDraft, projectMutating]
  )

  const deleteProjectRowComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      const commentId = Number(comment.id)
      if (!slug || !Number.isInteger(commentId) || commentId <= 0) {
        setProjectRowDetailError('This project comment cannot be deleted from mobile.')
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.project.deleteIssueCommentBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            commentId
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string | { message?: string }
        }
        if (result.ok === false) {
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : (result.error?.message ?? 'Failed to delete comment')
          )
        }
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.filter((candidate) => Number(candidate.id) !== commentId)
              }
            : current
        )
        if (projectEditingCommentId === String(comment.id)) {
          setProjectEditingCommentId(null)
          setProjectEditingCommentDraft('')
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to delete comment')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectEditingCommentId, projectMutating]
  )

  const toggleProjectGitHubReviewThread = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !comment.threadId
      ) {
        return
      }
      const resolve = !comment.isResolved
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.resolveReviewThread',
          {
            repo: `id:${repo.id}`,
            threadId: comment.threadId,
            resolve
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
        }
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  candidate.threadId === comment.threadId
                    ? { ...candidate, isResolved: resolve }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update review thread'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating]
  )

  const replyToProjectGitHubComment = useCallback(
    async (row: GitHubProjectRow, comment: DetailComment): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || !repo || !row.content.number) {
        return
      }
      const key = String(comment.id)
      const body = (itemReplyDrafts[key] ?? '').trim()
      if (!body) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const canUseReviewReply =
          row.itemType === 'PULL_REQUEST' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
        const response = canUseReviewReply
          ? await client.sendRequest(
              'github.addPRReviewCommentReply',
              {
                repo: `id:${repo.id}`,
                prNumber: row.content.number,
                commentId: comment.id,
                body,
                threadId: comment.threadId,
                path: comment.path,
                line: comment.line
              },
              { timeoutMs: 30_000 }
            )
          : await client.sendRequest(
              'github.addIssueComment',
              {
                repo: `id:${repo.id}`,
                number: row.content.number,
                body: `@${commentAuthor(comment)} ${body}`,
                type: projectRowType(row) ?? 'issue'
              },
              { timeoutMs: 30_000 }
            )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to reply')
        }
        const reply: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: 'You',
          path: comment.path,
          line: comment.line,
          threadId: comment.threadId
        }
        setItemReplyDrafts((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, reply] }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to reply')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, itemReplyDrafts, projectMutating]
  )

  const mutateProjectRowMetadata = useCallback(
    async (
      row: GitHubProjectRow,
      updates: {
        addLabels?: string[]
        removeLabels?: string[]
        addAssignees?: string[]
        removeAssignees?: string[]
      }
    ): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      if (!slug || !row.content.number) {
        setProjectRowDetailError('This project item cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          'github.project.updateIssueBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            number: row.content.number,
            updates
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')
        }
        const applyContentUpdate = (candidate: GitHubProjectRow): GitHubProjectRow => {
          const labels = new Map(candidate.content.labels.map((label) => [label.name, label]))
          for (const label of updates.addLabels ?? []) {
            if (!labels.has(label)) {
              labels.set(label, { name: label, color: '808080' })
            }
          }
          for (const label of updates.removeLabels ?? []) {
            labels.delete(label)
          }
          const assignees = new Map(
            candidate.content.assignees.map((assignee) => [assignee.login, assignee])
          )
          for (const login of updates.addAssignees ?? []) {
            if (!assignees.has(login)) {
              assignees.set(login, { login, name: null })
            }
          }
          for (const login of updates.removeAssignees ?? []) {
            assignees.delete(login)
          }
          return {
            ...candidate,
            content: {
              ...candidate.content,
              labels: [...labels.values()],
              assignees: [...assignees.values()]
            }
          }
        }
        setProjectRowItem((current) =>
          current && current.id === row.id ? applyContentUpdate(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? applyContentUpdate(candidate) : candidate
                )
              }
            : table
        )
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                labels: [
                  ...new Set([
                    ...current.labels.filter(
                      (label) => !(updates.removeLabels ?? []).includes(label)
                    ),
                    ...(updates.addLabels ?? [])
                  ])
                ],
                assignees: [
                  ...new Set([
                    ...current.assignees.filter(
                      (login) => !(updates.removeAssignees ?? []).includes(login)
                    ),
                    ...(updates.addAssignees ?? [])
                  ])
                ]
              }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update item')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectMutating]
  )

  const mutateProjectRowField = useCallback(
    async (
      row: GitHubProjectRow,
      field: GitHubProjectField,
      value: GitHubProjectFieldMutationValue | null
    ): Promise<void> => {
      if (!client || !githubProjectTable || projectMutating) {
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          value === null ? 'github.project.clearItemField' : 'github.project.updateItemField',
          value === null
            ? {
                projectId: githubProjectTable.project.id,
                itemId: row.id,
                fieldId: field.id
              }
            : {
                projectId: githubProjectTable.project.id,
                itemId: row.id,
                fieldId: field.id,
                value
              },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update project field')
        }
        const patchRow = (candidate: GitHubProjectRow): GitHubProjectRow => {
          const fieldValuesByFieldId = { ...candidate.fieldValuesByFieldId }
          if (value === null) {
            delete fieldValuesByFieldId[field.id]
          } else {
            fieldValuesByFieldId[field.id] = optimisticProjectFieldValue(field, value)
          }
          return { ...candidate, fieldValuesByFieldId }
        }
        setProjectRowItem((current) =>
          current && current.id === row.id ? patchRow(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? patchRow(candidate) : candidate
                )
              }
            : table
        )
        if (value === null) {
          setProjectFieldDrafts((current) => ({ ...current, [field.id]: '' }))
        }
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update project field'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [client, githubProjectTable, projectMutating]
  )

  const mutateProjectRowIssueType = useCallback(
    async (row: GitHubProjectRow, issueType: GitHubIssueType | null): Promise<void> => {
      if (!client || projectMutating) {
        return
      }
      const slug = splitRepositorySlug(row.content.repository)
      if (row.itemType !== 'ISSUE' || !slug || !row.content.number) {
        setProjectRowDetailError('This project issue type cannot be edited from mobile.')
        return
      }
      setProjectMutating(true)
      try {
        const response = await client.sendRequest(
          'github.project.updateIssueTypeBySlug',
          {
            owner: slug.owner,
            repo: slug.repo,
            number: row.content.number,
            issueTypeId: issueType?.id ?? null
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: { message?: string } }
        if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update issue type')
        }
        const patchRow = (candidate: GitHubProjectRow): GitHubProjectRow => ({
          ...candidate,
          content: { ...candidate.content, issueType }
        })
        setProjectRowItem((current) =>
          current && current.id === row.id ? patchRow(current) : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id ? patchRow(candidate) : candidate
                )
              }
            : table
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to update issue type')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, projectMutating]
  )

  const requestProjectGitHubReviewers = useCallback(
    async (row: GitHubProjectRow, logins?: string[]): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || row.itemType !== 'PULL_REQUEST' || !repo) {
        return
      }
      const reviewers = logins ?? splitReviewerList(projectReviewersDraft)
      if (reviewers.length === 0 || !row.content.number) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.requestPRReviewers',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            reviewers
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to request reviewers')
        }
        const nextReviewRequests = (() => {
          const byLogin = new Map<string, GitHubAssignableUser>()
          for (const reviewer of projectRowDetail?.provider === 'github'
            ? projectRowDetail.reviewRequests
            : []) {
            const login = reviewer.login.trim()
            if (login) {
              byLogin.set(login.toLowerCase(), reviewer)
            }
          }
          for (const login of reviewers) {
            const normalized = login.trim().replace(/^@/, '')
            if (normalized && !byLogin.has(normalized.toLowerCase())) {
              byLogin.set(normalized.toLowerCase(), {
                login: normalized,
                name: null,
                avatarUrl: null
              })
            }
          }
          return Array.from(byLogin.values())
        })()
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, reviewRequests: nextReviewRequests }
            : current
        )
        if (!logins) {
          setProjectReviewersDraft('')
        }
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to request reviewers')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating, projectReviewersDraft, projectRowDetail]
  )

  const refreshProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
      ) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.prChecks',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            headSha: projectRowDetail?.provider === 'github' ? projectRowDetail.headSha : undefined,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (!Array.isArray(response.result)) {
          throw new Error('Invalid checks response')
        }
        const checks = response.result as GitHubDetailCheck[]
        setProjectRowDetail((current) =>
          current?.provider === 'github' ? { ...current, checks } : current
        )
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating, projectRowDetail]
  )

  const rerunProjectGitHubChecks = useCallback(
    async (row: GitHubProjectRow, failedOnly: boolean): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
      ) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.rerunPRChecks',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            headSha: projectRowDetail?.provider === 'github' ? projectRowDetail.headSha : undefined,
            failedOnly
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to rerun checks')
        }
        setProjectRowDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setProjectRowDetailError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating, projectRowDetail]
  )

  const toggleProjectGitHubFileViewed = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (!client || projectMutating || row.itemType !== 'PULL_REQUEST' || !repo) {
        return
      }
      if (projectRowDetail?.provider !== 'github' || !projectRowDetail.pullRequestId) {
        setProjectRowDetailError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.setPRFileViewed',
          {
            repo: `id:${repo.id}`,
            pullRequestId: projectRowDetail.pullRequestId,
            path: file.path,
            viewed
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error('Failed to sync viewed state with GitHub.')
        }
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                files: current.files.map((candidate) =>
                  candidate.path === file.path
                    ? { ...candidate, viewerViewedState: viewed ? 'VIEWED' : 'UNVIEWED' }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to update viewed state'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating, projectRowDetail]
  )

  const toggleProjectGitHubFileExpansion = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile): Promise<void> => {
      if (expandedPrFilePath === file.path) {
        setExpandedPrFilePath(null)
        return
      }
      setExpandedPrFilePath(file.path)
      if (prFileContents[file.path]) {
        return
      }
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number ||
        projectRowDetail?.provider !== 'github' ||
        !projectRowDetail.headSha ||
        !projectRowDetail.baseSha
      ) {
        setProjectRowDetailError('Unable to load file contents for this pull request.')
        return
      }
      setPrFileLoadingPath(file.path)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.prFileContents',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: projectRowDetail.headSha,
            baseSha: projectRowDetail.baseSha
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        setPrFileContents((current) => ({
          ...current,
          [file.path]: response.result as GitHubPRFileContents
        }))
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to load file contents'
        )
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [client, expandedPrFilePath, findProjectRowRepo, prFileContents, projectRowDetail]
  )

  const addProjectGitHubFileReviewComment = useCallback(
    async (row: GitHubProjectRow, file: GitHubDetailFile, line: number): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
      ) {
        return
      }
      if (projectRowDetail?.provider !== 'github' || !projectRowDetail.headSha) {
        setProjectRowDetailError('Unable to comment without the PR head SHA.')
        return
      }
      const draftKey = `${file.path}:${line}`
      const body = (prFileCommentDrafts[draftKey] ?? '').trim()
      if (!body) {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.addPRReviewComment',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            commitId: projectRowDetail.headSha,
            path: file.path,
            line,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add review comment')
        }
        const comment: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          author: 'You',
          body,
          createdAt: new Date().toISOString(),
          path: file.path,
          line
        }
        setPrFileCommentDrafts((current) => {
          const next = { ...current }
          delete next[draftKey]
          return next
        })
        setProjectRowDetail((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to add review comment'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, prFileCommentDrafts, projectMutating, projectRowDetail]
  )

  const mergeProjectGitHubPullRequest = useCallback(
    async (row: GitHubProjectRow, method: HostedReviewMergeMethod): Promise<void> => {
      const repo = findProjectRowRepo(row)
      if (
        !client ||
        projectMutating ||
        row.itemType !== 'PULL_REQUEST' ||
        !repo ||
        !row.content.number
      ) {
        return
      }
      if (row.content.state === 'CLOSED' || row.content.state === 'MERGED') {
        return
      }
      setProjectMutating(true)
      setProjectRowDetailError('')
      try {
        const response = await client.sendRequest(
          'github.mergePR',
          {
            repo: `id:${repo.id}`,
            prNumber: row.content.number,
            method
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to merge pull request')
        }
        setProjectRowItem((current) =>
          current?.id === row.id
            ? { ...current, content: { ...current.content, state: 'MERGED' } }
            : current
        )
        setGithubProjectTable((table) =>
          table
            ? {
                ...table,
                rows: table.rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, content: { ...candidate.content, state: 'MERGED' } }
                    : candidate
                )
              }
            : table
        )
      } catch (err) {
        setProjectRowDetailError(
          err instanceof Error ? err.message : 'Failed to merge pull request'
        )
      } finally {
        setProjectMutating(false)
      }
    },
    [client, findProjectRowRepo, projectMutating]
  )

  const toggleGitHubStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'open' : 'closed'
      try {
        const method = item.source.type === 'issue' ? 'github.updateIssue' : 'github.updatePRState'
        const params =
          item.source.type === 'issue'
            ? {
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                updates: { state: nextState }
              }
            : {
                repo: `id:${item.source.repoId}`,
                prNumber: item.source.number,
                updates: { state: nextState }
              }
        const response = await client.sendRequest(method, params)
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub status')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update status')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )

  const toggleGitLabStatus = useCallback(
    async (item: Extract<TaskItem, { provider: 'gitlab' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.state === 'merged') {
        return
      }
      setMutatingStatus(true)
      setError('')
      const nextState = item.source.state === 'closed' ? 'opened' : 'closed'
      try {
        const response =
          item.source.type === 'issue'
            ? await client.sendRequest('gitlab.updateIssue', {
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                updates: { state: nextState },
                projectRef: item.source.projectRef
              })
            : await client.sendRequest('gitlab.updateMRState', {
                repo: `id:${item.source.repoId}`,
                iid: item.source.number,
                state: nextState,
                projectRef: item.source.projectRef
              })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitLab item')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )

  const updateGitHubIssueMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      updates: {
        title?: string
        body?: string
        addLabels?: string[]
        removeLabels?: string[]
        addAssignees?: string[]
        removeAssignees?: string[]
      }
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.updateIssue',
          {
            repo: `id:${item.source.repoId}`,
            number: item.source.number,
            updates
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub issue')
        }

        const nextLabels = [
          ...new Set([
            ...(detailPayload?.provider === 'github'
              ? detailPayload.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )
              : item.source.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )),
            ...(updates.addLabels ?? [])
          ])
        ]
        const nextAssignees =
          detailPayload?.provider === 'github'
            ? [
                ...new Set([
                  ...detailPayload.assignees.filter(
                    (login) => !(updates.removeAssignees ?? []).includes(login)
                  ),
                  ...(updates.addAssignees ?? [])
                ])
              ]
            : undefined
        const nextTitle = updates.title?.trim()
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                ...(nextTitle ? { title: nextTitle } : {}),
                source: {
                  ...current.source,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  labels: nextLabels
                }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  source: {
                    ...candidate.source,
                    ...(nextTitle ? { title: nextTitle } : {}),
                    labels: nextLabels
                  }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                labels: nextLabels,
                ...(updates.body !== undefined ? { body: updates.body } : {}),
                ...(nextAssignees ? { assignees: nextAssignees } : {})
              }
            : current
        )
        setItemAddLabelsDraft('')
        setItemRemoveLabelsDraft('')
        setItemAddAssigneesDraft('')
        setItemRemoveAssigneesDraft('')
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitHub issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, loadTasks, mutatingStatus]
  )

  const updateGitHubPullRequestMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      updates: { title?: string; body?: string }
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      const nextTitle = updates.title?.trim()
      if (updates.title !== undefined && !nextTitle) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.updatePR',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            updates: {
              ...(nextTitle !== undefined ? { title: nextTitle } : {}),
              ...(updates.body !== undefined ? { body: updates.body } : {})
            }
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitHub pull request')
        }
        if (nextTitle !== undefined) {
          setActionItem((current) =>
            current?.provider === 'github' && current.source.id === item.source.id
              ? {
                  ...current,
                  title: nextTitle,
                  source: { ...current.source, title: nextTitle }
                }
              : current
          )
          setItems((current) =>
            current.map((candidate) =>
              candidate.provider === 'github' && candidate.source.id === item.source.id
                ? {
                    ...candidate,
                    title: nextTitle,
                    source: { ...candidate.source, title: nextTitle }
                  }
                : candidate
            )
          )
        }
        if (updates.body !== undefined) {
          setDetailPayload((current) =>
            current?.provider === 'github' ? { ...current, body: updates.body ?? '' } : current
          )
        }
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitHub pull request')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )

  const updateGitLabIssueMetadata = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'gitlab' }>,
      updates: {
        title?: string
        body?: string
        addLabels?: string[]
        removeLabels?: string[]
        addAssignees?: string[]
        removeAssignees?: string[]
      }
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const method = item.source.type === 'issue' ? 'gitlab.updateIssue' : 'gitlab.updateMR'
        const params =
          item.source.type === 'issue'
            ? {
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                updates,
                projectRef: item.source.projectRef
              }
            : {
                repo: `id:${item.source.repoId}`,
                iid: item.source.number,
                projectRef: item.source.projectRef,
                updates: {
                  title: updates.title,
                  body: updates.body,
                  addLabels: updates.addLabels,
                  removeLabels: updates.removeLabels
                }
              }
        const response = await client.sendRequest(method, params, { timeoutMs: 30_000 })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to update GitLab item')
        }
        const nextLabels = [
          ...new Set([
            ...(detailPayload?.provider === 'gitlab'
              ? detailPayload.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )
              : item.source.labels.filter(
                  (label) => !(updates.removeLabels ?? []).includes(label)
                )),
            ...(updates.addLabels ?? [])
          ])
        ]
        const nextAssignees =
          detailPayload?.provider === 'gitlab'
            ? [
                ...new Set([
                  ...detailPayload.assignees.filter(
                    (login) => !(updates.removeAssignees ?? []).includes(login)
                  ),
                  ...(updates.addAssignees ?? [])
                ])
              ]
            : undefined
        const nextTitle = updates.title?.trim()
        setActionItem((current) =>
          current?.provider === 'gitlab' && current.source.id === item.source.id
            ? {
                ...current,
                ...(nextTitle ? { title: nextTitle } : {}),
                source: {
                  ...current.source,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  labels: nextLabels
                }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'gitlab' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  ...(nextTitle ? { title: nextTitle } : {}),
                  source: {
                    ...candidate.source,
                    ...(nextTitle ? { title: nextTitle } : {}),
                    labels: nextLabels
                  }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'gitlab'
            ? {
                ...current,
                labels: nextLabels,
                ...(updates.body !== undefined ? { body: updates.body } : {}),
                ...(nextAssignees ? { assignees: nextAssignees } : {})
              }
            : current
        )
        setItemAddLabelsDraft('')
        setItemRemoveLabelsDraft('')
        if (item.source.type === 'issue') {
          setItemAddAssigneesDraft('')
          setItemRemoveAssigneesDraft('')
        }
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update GitLab item')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, loadTasks, mutatingStatus]
  )

  const addHostedItemComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const body = itemCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response =
          item.provider === 'github'
            ? await client.sendRequest(
                'github.addIssueComment',
                {
                  repo: `id:${item.source.repoId}`,
                  number: item.source.number,
                  body,
                  type: item.source.type
                },
                { timeoutMs: 30_000 }
              )
            : await client.sendRequest(
                item.source.type === 'mr' ? 'gitlab.addMRComment' : 'gitlab.addIssueComment',
                item.source.type === 'mr'
                  ? {
                      repo: `id:${item.source.repoId}`,
                      iid: item.source.number,
                      body,
                      projectRef: item.source.projectRef
                    }
                  : {
                      repo: `id:${item.source.repoId}`,
                      number: item.source.number,
                      body,
                      projectRef: item.source.projectRef
                    },
                { timeoutMs: 30_000 }
              )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add comment')
        }
        const comment: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: 'You'
        }
        setItemCommentDraft('')
        setDetailPayload((current) =>
          current &&
          ((item.provider === 'github' && current.provider === 'github') ||
            (item.provider === 'gitlab' && current.provider === 'gitlab'))
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, itemCommentDraft, mutatingStatus]
  )

  const copyTaskLink = useCallback(async (key: string, url: string): Promise<void> => {
    try {
      await Clipboard.setStringAsync(url)
      setCopiedLinkKey(key)
      scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy link')
    }
  }, [])

  const copyTextToClipboard = useCallback(async (key: string, value: string): Promise<void> => {
    try {
      await Clipboard.setStringAsync(value)
      setCopiedLinkKey(key)
      scheduleMobileTaskCopyFeedbackReset(copiedLinkResetTimerRef, key, setCopiedLinkKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy text')
    }
  }, [])

  const requestGitHubReviewers = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, logins?: string[]): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      const reviewers = logins ?? splitReviewerList(itemReviewersDraft)
      if (reviewers.length === 0) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.requestPRReviewers',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            reviewers
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to request reviewers')
        }
        const nextReviewRequests = (() => {
          const byLogin = new Map<string, GitHubAssignableUser>()
          for (const reviewer of detailPayload?.provider === 'github'
            ? detailPayload.reviewRequests
            : (item.source.reviewRequests ?? [])) {
            const login = reviewer.login.trim()
            if (login) {
              byLogin.set(login.toLowerCase(), reviewer)
            }
          }
          for (const login of reviewers) {
            const normalized = login.trim().replace(/^@/, '')
            if (normalized && !byLogin.has(normalized.toLowerCase())) {
              byLogin.set(normalized.toLowerCase(), {
                login: normalized,
                name: null,
                avatarUrl: null
              })
            }
          }
          return Array.from(byLogin.values())
        })()
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                source: { ...current.source, reviewRequests: nextReviewRequests }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  source: { ...candidate.source, reviewRequests: nextReviewRequests }
                }
              : candidate
          )
        )
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? { ...current, reviewRequests: nextReviewRequests }
            : current
        )
        if (!logins) {
          setItemReviewersDraft('')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to request reviewers')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, itemReviewersDraft, mutatingStatus]
  )

  const refreshGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.prChecks',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (!Array.isArray(response.result)) {
          throw new Error('Invalid checks response')
        }
        const checks = response.result as GitHubDetailCheck[]
        const checksSummary = buildGitHubCheckSummary(checks)
        setDetailPayload((current) =>
          current?.provider === 'github' ? { ...current, checks } : current
        )
        setActionItem((current) =>
          current?.provider === 'github' && current.source.id === item.source.id
            ? {
                ...current,
                source: { ...current.source, checksSummary }
              }
            : current
        )
        setItems((current) =>
          current.map((candidate) =>
            candidate.provider === 'github' && candidate.source.id === item.source.id
              ? {
                  ...candidate,
                  source: { ...candidate.source, checksSummary }
                }
              : candidate
          )
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh checks')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus]
  )

  const rerunGitHubChecks = useCallback(
    async (item: Extract<TaskItem, { provider: 'github' }>, failedOnly: boolean): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.rerunPRChecks',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            headSha: detailPayload?.provider === 'github' ? detailPayload.headSha : undefined,
            failedOnly
          },
          { timeoutMs: 60_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to rerun checks')
        }
        setDetailRefreshSeq((current) => current + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rerun checks')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus]
  )

  const toggleGitHubFileViewed = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: NonNullable<Extract<DetailPayload, { provider: 'github' }>['files'][number]>
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      if (detailPayload?.provider !== 'github' || !detailPayload.pullRequestId) {
        setError('Unable to sync viewed state for this pull request.')
        return
      }
      const viewed = file.viewerViewedState !== 'VIEWED'
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.setPRFileViewed',
          {
            repo: `id:${item.source.repoId}`,
            pullRequestId: detailPayload.pullRequestId,
            path: file.path,
            viewed
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error('Failed to sync viewed state with GitHub.')
        }
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                files: current.files.map((candidate) =>
                  candidate.path === file.path
                    ? { ...candidate, viewerViewedState: viewed ? 'VIEWED' : 'UNVIEWED' }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update viewed state')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus]
  )

  const toggleGitHubReviewThread = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr' || !comment.threadId) {
        return
      }
      const resolve = !comment.isResolved
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.resolveReviewThread',
          {
            repo: `id:${item.source.repoId}`,
            threadId: comment.threadId,
            resolve
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        if (response.result !== true) {
          throw new Error(resolve ? 'Failed to resolve thread' : 'Failed to reopen thread')
        }
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? {
                ...current,
                comments: current.comments.map((candidate) =>
                  candidate.threadId === comment.threadId
                    ? { ...candidate, isResolved: resolve }
                    : candidate
                )
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update review thread')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, mutatingStatus]
  )

  const toggleGitHubFileExpansion = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile
    ): Promise<void> => {
      if (expandedPrFilePath === file.path) {
        setExpandedPrFilePath(null)
        return
      }
      setExpandedPrFilePath(file.path)
      if (prFileContents[file.path]) {
        return
      }
      if (
        !client ||
        item.source.type !== 'pr' ||
        detailPayload?.provider !== 'github' ||
        !detailPayload.headSha ||
        !detailPayload.baseSha
      ) {
        setError('Unable to load file contents for this pull request.')
        return
      }
      setPrFileLoadingPath(file.path)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.prFileContents',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            path: file.path,
            oldPath: file.oldPath,
            status: file.status ?? 'modified',
            headSha: detailPayload.headSha,
            baseSha: detailPayload.baseSha
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        setPrFileContents((current) => ({
          ...current,
          [file.path]: response.result as GitHubPRFileContents
        }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file contents')
      } finally {
        setPrFileLoadingPath(null)
      }
    },
    [client, detailPayload, expandedPrFilePath, prFileContents]
  )

  const addGitHubFileReviewComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      file: GitHubDetailFile,
      line: number
    ): Promise<void> => {
      if (!client || mutatingStatus || item.source.type !== 'pr') {
        return
      }
      if (detailPayload?.provider !== 'github' || !detailPayload.headSha) {
        setError('Unable to comment without the PR head SHA.')
        return
      }
      const draftKey = `${file.path}:${line}`
      const body = (prFileCommentDrafts[draftKey] ?? '').trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'github.addPRReviewComment',
          {
            repo: `id:${item.source.repoId}`,
            prNumber: item.source.number,
            commitId: detailPayload.headSha,
            path: file.path,
            line,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add review comment')
        }
        const comment: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          author: 'You',
          body,
          createdAt: new Date().toISOString(),
          path: file.path,
          line
        }
        setPrFileCommentDrafts((current) => {
          const next = { ...current }
          delete next[draftKey]
          return next
        })
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add review comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, detailPayload, mutatingStatus, prFileCommentDrafts]
  )

  const replyToGitHubComment = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }>,
      comment: DetailComment
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const key = String(comment.id)
      const body = (itemReplyDrafts[key] ?? '').trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const canUseReviewReply =
          item.source.type === 'pr' &&
          comment.path &&
          typeof comment.line === 'number' &&
          typeof comment.id === 'number'
        const response = canUseReviewReply
          ? await client.sendRequest(
              'github.addPRReviewCommentReply',
              {
                repo: `id:${item.source.repoId}`,
                prNumber: item.source.number,
                commentId: comment.id,
                body,
                threadId: comment.threadId,
                path: comment.path,
                line: comment.line
              },
              { timeoutMs: 30_000 }
            )
          : await client.sendRequest(
              'github.addIssueComment',
              {
                repo: `id:${item.source.repoId}`,
                number: item.source.number,
                body: `@${commentAuthor(comment)} ${body}`,
                type: item.source.type
              },
              { timeoutMs: 30_000 }
            )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          error?: string
          comment?: DetailComment
        }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to reply')
        }
        const reply: DetailComment = result.comment ?? {
          id: `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: 'You',
          path: comment.path,
          line: comment.line,
          threadId: comment.threadId
        }
        setItemReplyDrafts((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        setDetailPayload((current) =>
          current?.provider === 'github'
            ? { ...current, comments: [...current.comments, reply] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reply')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, itemReplyDrafts, mutatingStatus]
  )

  const mergeHostedReview = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }>,
      method: HostedReviewMergeMethod
    ): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      if (item.provider === 'github' && item.source.type !== 'pr') {
        return
      }
      if (item.provider === 'gitlab' && item.source.type !== 'mr') {
        return
      }
      if (item.provider === 'github' && isGitHubPrMergeBlocked(item)) {
        setError('GitHub reports merge conflicts. Open in GitHub to continue.')
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response =
          item.provider === 'github'
            ? await client.sendRequest(
                'github.mergePR',
                {
                  repo: `id:${item.source.repoId}`,
                  prNumber: item.source.number,
                  method
                },
                { timeoutMs: 60_000 }
              )
            : await client.sendRequest(
                'gitlab.mergeMR',
                {
                  repo: `id:${item.source.repoId}`,
                  iid: item.source.number,
                  method,
                  projectRef: item.source.projectRef
                },
                { timeoutMs: 60_000 }
              )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to merge')
        }
        setActionItem(null)
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to merge')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus]
  )

  const setLinearStatus = useCallback(
    async (
      item: Extract<TaskItem, { provider: 'linear' }>,
      state: LinearState,
      options: { closeDetail?: boolean } = {}
    ): Promise<void> => {
      if (!client || !taskUiReady || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest('linear.updateIssue', {
          id: item.source.id,
          workspaceId: item.source.workspaceId,
          updates: { stateId: state.id }
        })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const nextState = {
          name: state.name,
          type: state.type,
          color: state.color ?? item.source.state.color
        }
        setItems((current) =>
          current.map((entry) =>
            entry.provider === 'linear' && entry.source.id === item.source.id
              ? createLinearTask({ ...entry.source, state: nextState })
              : entry
          )
        )
        setActionItem((current) => {
          if (!current || current.provider !== 'linear' || current.source.id !== item.source.id) {
            return current
          }
          if (options.closeDetail !== false) {
            return null
          }
          return createLinearTask({
            ...current.source,
            state: nextState
          }) as Extract<TaskItem, { provider: 'linear' }>
        })
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update Linear issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, loadTasks, mutatingStatus, taskUiReady]
  )

  const addLinearComment = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const body = linearCommentDraft.trim()
      if (!body) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.addIssueComment',
          {
            issueId: item.source.id,
            workspaceId: item.source.workspaceId,
            body
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as { ok?: boolean; id?: string; error?: string }
        if (result.ok === false) {
          throw new Error(result.error ?? 'Failed to add comment')
        }
        const comment: DetailComment = {
          id: result.id ?? `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          user: { displayName: 'You' }
        }
        setLinearCommentDraft('')
        setDetailPayload((current) =>
          current?.provider === 'linear'
            ? { ...current, comments: [...current.comments, comment] }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add Linear comment')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, linearCommentDraft, mutatingStatus]
  )

  const openLinearSubIssue = useCallback(
    async (child: LinearIssueChild, workspaceId?: string): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.getIssue',
          { id: child.id, workspaceId },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const issue = response.result as LinearIssue | null
        if (!issue) {
          throw new Error('Sub-issue not found')
        }
        setActionItem(createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, mutatingStatus]
  )

  const createLinearSubIssue = useCallback(
    async (item: Extract<TaskItem, { provider: 'linear' }>): Promise<void> => {
      if (!client || mutatingStatus) {
        return
      }
      const title = linearSubIssueTitle.trim()
      if (!title) {
        return
      }
      setMutatingStatus(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'linear.createIssue',
          {
            teamId: item.source.team.id,
            title,
            workspaceId: item.source.workspaceId,
            parentIssueId: item.source.id,
            projectId: item.source.project?.id ?? null
          },
          { timeoutMs: 30_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          id?: string
          identifier?: string
          title?: string
          url?: string
          error?: string
        }
        if (result.ok === false || !result.id || !result.identifier) {
          throw new Error(result.error ?? 'Failed to create sub-issue')
        }
        const child: LinearIssueChild = {
          id: result.id,
          identifier: result.identifier,
          title: result.title ?? title,
          url: result.url ?? ''
        }
        setLinearSubIssueTitle('')
        setDetailPayload((current) =>
          current?.provider === 'linear'
            ? {
                ...current,
                children: current.children.some((entry) => entry.id === child.id)
                  ? current.children
                  : [...current.children, child]
              }
            : current
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create Linear sub-issue')
      } finally {
        setMutatingStatus(false)
      }
    },
    [client, linearSubIssueTitle, mutatingStatus]
  )

  const createTask = useCallback(async (): Promise<void> => {
    if (!client || !tasksSupported || !taskStateHydrated || creatingTask) {
      return
    }
    const title = createTitle.trim()
    if (!title) {
      return
    }
    setCreatingTask(true)
    setError('')
    try {
      if (provider === 'github' || provider === 'gitlab') {
        const repo = hostedRepos.find((entry) => entry.id === createRepoId) ?? hostedRepos[0]
        if (!repo) {
          throw new Error(
            `Add a Git repository before creating a ${provider === 'github' ? 'GitHub' : 'GitLab'} issue.`
          )
        }
        const response = await client.sendRequest(
          provider === 'github' ? 'github.createIssue' : 'gitlab.createIssue',
          {
            repo: `id:${repo.id}`,
            title,
            body: createBody
          }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          number?: number
          url?: string
          error?: string
        }
        if (result.ok === false) {
          throw new Error(
            result.error ?? `Failed to create ${provider === 'github' ? 'GitHub' : 'GitLab'} issue`
          )
        }
        if (typeof result.number === 'number') {
          const createdAt = new Date().toISOString()
          if (provider === 'github') {
            setActionItem(
              createGitHubTask(repo, {
                id: `issue:${result.number}`,
                type: 'issue',
                number: result.number,
                title,
                state: 'open',
                url: result.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          } else {
            setActionItem(
              createGitLabTask(repo, {
                id: `issue:${result.number}`,
                type: 'issue',
                number: result.number,
                title,
                state: 'opened',
                url: result.url ?? '',
                labels: [],
                updatedAt: createdAt,
                author: null
              })
            )
          }
        }
      } else {
        const team = linearTeams.find((entry) => entry.id === createTeamId) ?? linearTeams[0]
        if (!team) {
          throw new Error('Select a Linear team first.')
        }
        const response = await client.sendRequest('linear.createIssue', {
          teamId: team.id,
          title,
          description: createBody.trim() || undefined,
          workspaceId: team.workspaceId
        })
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        const result = response.result as {
          ok?: boolean
          id?: string
          identifier?: string
          title?: string
          url?: string
          error?: string
        }
        if (result.ok === false || !result.id || !result.identifier) {
          throw new Error(result.error ?? 'Failed to create Linear issue')
        }
        setActionItem(
          createLinearTask({
            id: result.id,
            workspaceId: team.workspaceId,
            workspaceName: team.workspaceName,
            identifier: result.identifier,
            title: result.title ?? title,
            description: createBody.trim(),
            url: result.url ?? '',
            state: { name: 'Open', type: 'unstarted', color: colors.accentBlue },
            team,
            labels: [],
            priority: 0,
            updatedAt: new Date().toISOString()
          }) as Extract<TaskItem, { provider: 'linear' }>
        )
      }
      setShowCreateTask(false)
      setCreateTitle('')
      setCreateBody('')
      await loadTasks({ silent: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task')
    } finally {
      setCreatingTask(false)
    }
  }, [
    client,
    createBody,
    createRepoId,
    createTeamId,
    createTitle,
    creatingTask,
    hostedRepos,
    linearTeams,
    loadTasks,
    provider,
    taskStateHydrated,
    tasksSupported
  ])

  const setGitHubIssueSourcePreference = useCallback(
    async (repo: RepoSummary, preference: 'upstream' | 'origin'): Promise<void> => {
      if (!client || !taskUiReady) {
        return
      }
      setError('')
      try {
        const response = await client.sendRequest(
          'repo.update',
          {
            repo: `id:${repo.id}`,
            updates: { issueSourcePreference: preference }
          },
          { timeoutMs: 15_000 }
        )
        if (!isSuccess(response)) {
          throw new Error(response.error.message)
        }
        setRepos((current) =>
          current.map((candidate) =>
            candidate.id === repo.id
              ? { ...candidate, issueSourcePreference: preference }
              : candidate
          )
        )
        reposRef.current = reposRef.current.map((candidate) =>
          candidate.id === repo.id ? { ...candidate, issueSourcePreference: preference } : candidate
        )
        await loadTasks({ silent: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update issue source')
      }
    },
    [client, loadTasks, taskUiReady]
  )

  const renderCommentComposer = (args: {
    value: string
    onChangeText: (next: string) => void
    onSubmit: () => void
    disabled?: boolean
  }): ReactNode => {
    const hasText = args.value.trim().length > 0
    return (
      <View style={styles.commentComposer}>
        <TextInput
          style={[styles.input, styles.commentInput, styles.commentComposerInput]}
          value={args.value}
          onChangeText={args.onChangeText}
          placeholder="Add a comment"
          placeholderTextColor={colors.textMuted}
          editable={!args.disabled}
          multiline
          numberOfLines={1}
          textAlignVertical="top"
        />
        {hasText ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send comment"
            style={({ pressed }) => [
              styles.commentComposerSend,
              pressed && !args.disabled && styles.commentComposerSendPressed,
              args.disabled && styles.commentComposerSendDisabled
            ]}
            disabled={args.disabled}
            onPress={args.onSubmit}
          >
            <Send size={16} color={args.disabled ? colors.textMuted : colors.textPrimary} />
          </Pressable>
        ) : null}
      </View>
    )
  }

  const renderDetailComment = (
    comment: DetailComment,
    options: { nested?: boolean } = {}
  ): ReactNode => (
    <View
      key={String(comment.id)}
      style={[
        styles.commentBlock,
        options.nested && styles.commentReplyBlock,
        comment.isResolved && styles.commentResolvedBlock
      ]}
    >
      <Text style={styles.commentSource} numberOfLines={1}>
        {commentSourceLabel(comment)}
      </Text>
      <Text style={styles.commentMeta}>
        {commentAuthor(comment)}
        {commentDate(comment.createdAt) ? ` · ${commentDate(comment.createdAt)}` : ''}
      </Text>
      <MobileMarkdown content={comment.body} />
      {renderCommentReactions(comment)}
      {SHOW_MOBILE_COMMENT_THREAD_TOOLS &&
      actionItem?.provider === 'github' &&
      detailPayload?.provider === 'github' ? (
        <View style={styles.commentControls}>
          {SHOW_MOBILE_COMMENT_THREAD_TOOLS &&
          actionItem?.provider === 'github' &&
          detailPayload?.provider === 'github' ? (
            <>
              {actionItem.source.type === 'pr' && comment.threadId ? (
                <Pressable
                  style={styles.inlineSaveButtonCompact}
                  disabled={mutatingStatus}
                  onPress={() => void toggleGitHubReviewThread(actionItem, comment)}
                >
                  <Text style={styles.inlineSaveText}>
                    {comment.isResolved ? 'Reopen thread' : 'Resolve thread'}
                  </Text>
                </Pressable>
              ) : null}
              <TextInput
                style={[styles.input, styles.replyInput]}
                value={itemReplyDrafts[String(comment.id)] ?? ''}
                onChangeText={(next) =>
                  setItemReplyDrafts((current) => ({
                    ...current,
                    [String(comment.id)]: next
                  }))
                }
                placeholder="Reply"
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
              />
              <Pressable
                style={styles.inlineSaveButtonCompact}
                disabled={mutatingStatus || !(itemReplyDrafts[String(comment.id)] ?? '').trim()}
                onPress={() => void replyToGitHubComment(actionItem, comment)}
              >
                <Text style={styles.inlineSaveText}>Reply</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  )

  const renderDetailCommentGroup = (group: DetailCommentGroup): ReactNode => {
    const id = detailCommentGroupId(group)
    const root = detailCommentGroupRoot(group)
    const count = detailCommentGroupCount(group)
    const isCollapsedResolved =
      isResolvedDetailCommentGroup(group) && !expandedResolvedCommentGroups.has(id)

    if (isCollapsedResolved) {
      return (
        <Pressable
          key={id}
          style={styles.resolvedCommentSummary}
          onPress={() =>
            setExpandedResolvedCommentGroups((current) => {
              const next = new Set(current)
              next.add(id)
              return next
            })
          }
        >
          <Text style={styles.resolvedCommentTitle} numberOfLines={1}>
            Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by {commentAuthor(root)}
          </Text>
          <Text style={styles.detailSectionMeta}>{count > 1 ? `${count} comments` : 'Show'}</Text>
        </Pressable>
      )
    }

    return (
      <View key={id} style={styles.commentThreadGroup}>
        {group.kind === 'thread'
          ? [
              renderDetailComment(group.root),
              ...group.replies.map((reply) => renderDetailComment(reply, { nested: true }))
            ]
          : renderDetailComment(group.comment)}
      </View>
    )
  }

  const createTargetOptions = useMemo<PickerOption<string>[]>(
    () =>
      provider === 'github' || provider === 'gitlab'
        ? hostedRepos.map((repo) => ({
            value: repo.id,
            label: repo.displayName,
            subtitle: repo.path,
            renderIcon: () => (
              <View
                style={[
                  styles.pickerRepoDot,
                  { backgroundColor: getRepoBadgeColor(repo, repo.displayName) }
                ]}
              />
            )
          }))
        : linearTeams.map((team) => ({
            value: team.id,
            label: team.name,
            subtitle: team.workspaceName
          })),
    [hostedRepos, linearTeams, provider]
  )
  const selectedCreateTarget =
    provider === 'github' || provider === 'gitlab'
      ? (hostedRepos.find((repo) => repo.id === createRepoId) ?? hostedRepos[0] ?? null)
      : (linearTeams.find((team) => team.id === createTeamId) ?? linearTeams[0] ?? null)
  const selectedCreateTargetLabel =
    provider === 'github' || provider === 'gitlab'
      ? ((selectedCreateTarget as RepoSummary | null)?.displayName ?? 'Select target')
      : ((selectedCreateTarget as LinearTeam | null)?.name ?? 'Select target')
  const providerLabel =
    provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : 'Linear'
  const showHeaderCreateTask =
    provider === 'linear' || (provider === 'github' && githubMode === 'items')
  const providerOptions = useMemo(
    () => PROVIDER_OPTIONS.filter((option) => visibleProviders.includes(option.value)),
    [visibleProviders]
  )
  const selectedCreateRepo =
    provider === 'github' || provider === 'gitlab'
      ? (selectedCreateTarget as RepoSummary | null)
      : null
  const selectedCreateGitHubSources =
    provider === 'github' && selectedCreateRepo
      ? githubRepoSources[selectedCreateRepo.id]
      : undefined
  const selectedCreateIssuePreference =
    selectedCreateRepo?.issueSourcePreference === 'origin' ||
    selectedCreateRepo?.issueSourcePreference === 'upstream'
      ? selectedCreateRepo.issueSourcePreference
      : 'upstream'
  const githubIssueSourceRows = useMemo(
    () =>
      selectedHostedRepos
        .map((repo) => ({ repo, sources: githubRepoSources[repo.id] }))
        .filter((entry): entry is { repo: RepoSummary; sources: GitHubRepoSources } =>
          hasGitHubIssueSourceChoice(entry.sources)
        ),
    [githubRepoSources, selectedHostedRepos]
  )
  const githubIssueSourceLabel =
    githubIssueSourceRows.length === 1
      ? issueSourceSlug(
          githubIssueSourceRows[0]!.repo.issueSourcePreference === 'origin'
            ? githubIssueSourceRows[0]!.sources.prs
            : githubIssueSourceRows[0]!.sources.upstreamCandidate
        )
      : `${githubIssueSourceRows.length} sources`
  const repoPickerLabel =
    selectedRepoIds.size === 0 || selectedHostedRepos.length === hostedRepos.length
      ? 'All repos'
      : selectedHostedRepos.length === 1
        ? selectedHostedRepos[0]!.displayName
        : `${selectedHostedRepos.length} repos`
  const repoPickerSelectedRepo =
    selectedRepoIds.size > 0 && selectedHostedRepos.length === 1 ? selectedHostedRepos[0]! : null
  const workspaceRepoOptions = useMemo<PickerOption<string>[]>(
    () =>
      workspaceRepos.map((repo) => ({
        value: repo.id,
        label: repo.displayName,
        subtitle: repo.path,
        renderIcon: () => (
          <View
            style={[
              styles.pickerRepoDot,
              { backgroundColor: getRepoBadgeColor(repo, repo.displayName) }
            ]}
          />
        )
      })),
    [workspaceRepos]
  )
  const sortedItems = useMemo(() => {
    const next = [...items]
    if (taskSort === 'repository') {
      next.sort((a, b) => compareTasksByRepository(a, b, reposById))
    } else {
      next.sort(compareTasksByUpdated)
    }
    return next
  }, [items, reposById, taskSort])
  const displayedEntries = useMemo<TaskListEntry[]>(() => {
    if (taskSort !== 'repository') {
      return sortedItems.map((item) => ({ type: 'item', key: item.key, item }))
    }
    const entries: TaskListEntry[] = []
    let previousRepoKey = ''
    for (const item of sortedItems) {
      const repo = taskRepositoryMeta(item, reposById)
      if (repo.key !== previousRepoKey) {
        entries.push({
          type: 'section',
          key: `section:${repo.key}`,
          label: repo.label,
          color: repo.color
        })
        previousRepoKey = repo.key
      }
      entries.push({ type: 'item', key: item.key, item })
    }
    return entries
  }, [reposById, sortedItems, taskSort])
  const sortLabel = SORT_OPTIONS.find((option) => option.value === taskSort)?.label ?? 'Updated'
  const githubProjectFields = githubProjectTable?.selectedView.fields ?? []
  const githubProjectViewSort = githubProjectTable?.selectedView.sortByFields?.[0] ?? null
  const githubProjectSortField = githubProjectSortOverride
    ? githubProjectFields.find((field) => field.id === githubProjectSortOverride.fieldId)
    : githubProjectViewSort?.field
  const githubProjectSortDirection =
    githubProjectSortOverride?.direction ?? githubProjectViewSort?.direction ?? null
  const githubProjectSortLabel = githubProjectSortField
    ? `${githubProjectSortField.name} ${githubProjectSortDirection === 'DESC' ? 'desc' : 'asc'}`
    : 'View order'
  const githubProjectFieldsLabel =
    githubProjectAvailableSummaryFields.length > 0
      ? `${githubProjectSummaryFields.length}/${githubProjectAvailableSummaryFields.length} fields`
      : 'Fields'
  const githubProjectSortOptions = useMemo<PickerOption<string>[]>(
    () => [
      {
        value: PROJECT_VIEW_DEFAULT_SORT,
        label: 'View order',
        subtitle: githubProjectViewSort
          ? `Uses ${githubProjectViewSort.field.name} ${githubProjectViewSort.direction.toLowerCase()}`
          : 'Uses GitHub rank order'
      },
      ...githubProjectFields.map((field) => {
        const active = githubProjectSortOverride?.fieldId === field.id
        const nextDirection =
          !active || githubProjectSortOverride.direction === 'DESC' ? 'ascending' : 'descending'
        return {
          value: field.id,
          label: field.name,
          subtitle: active
            ? `Currently ${githubProjectSortOverride.direction.toLowerCase()} · tap for ${nextDirection}`
            : 'Sort ascending'
        }
      })
    ],
    [githubProjectFields, githubProjectSortOverride, githubProjectViewSort]
  )
  const githubProjectViewOptions = useMemo<PickerOption<string>[]>(
    () =>
      githubProjectViews.map((view) => ({
        value: view.id,
        label: view.name,
        subtitle:
          view.layout === 'TABLE_LAYOUT' ? `View #${view.number}` : 'Unsupported layout on mobile',
        disabled: view.layout !== 'TABLE_LAYOUT'
      })),
    [githubProjectViews]
  )
  const githubPresetOptions = githubKind === 'prs' ? PR_PRESETS : ISSUE_PRESETS
  const githubPresetPickerOptions = useMemo(
    () =>
      githubPresetOptions.map((option) =>
        option.value === defaultGitHubPreset
          ? { ...option, subtitle: option.subtitle ? `${option.subtitle} · Default` : 'Default' }
          : option
      ),
    [defaultGitHubPreset, githubPresetOptions]
  )
  const githubPresetLabel =
    githubPresetOptions.find((preset) => preset.value === githubPreset)?.label ?? 'Open'
  const gitlabFilterLabel =
    GITLAB_FILTER_OPTIONS.find((filter) => filter.value === gitlabFilter)?.label ?? 'Open'
  const linearFilterLabel =
    LINEAR_FILTER_OPTIONS.find((filter) => filter.value === linearFilter)?.label ?? 'All'
  const linearViewLabel =
    LINEAR_VIEW_OPTIONS.find((option) => option.value === linearViewMode)?.label ?? 'List'
  const linearGroupLabel =
    LINEAR_GROUP_OPTIONS.find((option) => option.value === linearGroupBy)?.label ?? 'No grouping'
  const linearOrderLabel =
    LINEAR_ORDER_OPTIONS.find((option) => option.value === linearOrderBy)?.label ?? 'Priority'
  const linearWorkspaceLabel =
    selectedLinearWorkspaceId === 'all'
      ? 'All workspaces'
      : (linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId)
          ?.organizationName ??
        linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId)
          ?.displayName ??
        'Workspace')
  const linearWorkspaceOptions = useMemo<PickerOption<string>[]>(
    () => [
      { value: 'all', label: 'All workspaces' },
      ...linearWorkspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.organizationName ?? workspace.displayName ?? workspace.id
      }))
    ],
    [linearWorkspaces]
  )
  const linearTeamLabel =
    selectedLinearTeamIds.size === 0 || selectedLinearTeamIds.size === linearTeams.length
      ? 'All teams'
      : selectedLinearTeamIds.size === 1
        ? (linearTeams.find((team) => selectedLinearTeamIds.has(team.id))?.name ?? '1 team')
        : `${selectedLinearTeamIds.size} teams`
  const effectiveLinearDisplayProperties = useMemo(() => {
    const next = new Set(linearDisplayProperties)
    if (linearGroupBy === 'status') {
      next.delete('state')
    }
    if (linearGroupBy === 'assignee') {
      next.delete('assignee')
    }
    if (linearGroupBy === 'priority') {
      next.delete('priority')
    }
    if (linearGroupBy === 'team') {
      next.delete('team')
    }
    if (selectedLinearTeamIds.size <= 1 && !linearTeamPropertyTouched) {
      next.delete('team')
    } else if (selectedLinearTeamIds.size > 1 && !linearTeamPropertyTouched) {
      next.add('team')
    }
    return next
  }, [
    linearDisplayProperties,
    linearGroupBy,
    linearTeamPropertyTouched,
    selectedLinearTeamIds.size
  ])
  const linearIssuesForView = useMemo(
    () =>
      items
        .filter(
          (item): item is Extract<TaskItem, { provider: 'linear' }> => item.provider === 'linear'
        )
        .map((item) => item.source)
        .sort((a, b) => compareLinearIssues(a, b, linearOrderBy)),
    [items, linearOrderBy]
  )
  const linearIssueSections = useMemo(
    () => groupLinearIssues(linearIssuesForView, linearGroupBy, linearOrderBy),
    [linearGroupBy, linearIssuesForView, linearOrderBy]
  )
  // Why: FlatList treats data identity as meaningful; unrelated renders should
  // not rebuild the section/item wrapper array.
  const linearListEntries = useMemo<LinearListEntry[]>(
    () =>
      linearIssueSections.flatMap((section) =>
        linearGroupBy === 'none'
          ? section.issues.map((issue) => ({ type: 'issue' as const, issue }))
          : [
              { type: 'section' as const, section },
              ...section.issues.map((issue) => ({ type: 'issue' as const, issue }))
            ]
      ),
    [linearGroupBy, linearIssueSections]
  )
  const linearBoardSections = useMemo(
    () =>
      groupLinearIssues(
        linearIssuesForView,
        linearGroupBy === 'none' ? 'status' : linearGroupBy,
        linearOrderBy
      ),
    [linearGroupBy, linearIssuesForView, linearOrderBy]
  )
  const githubModeLabel =
    githubMode === 'project' ? 'Projects' : githubKind === 'prs' ? 'PRs' : 'Issues'
  const activeProjectLabel = githubProjectTable
    ? githubProjectTable.project.title
    : activeGitHubProject
      ? `${activeGitHubProject.owner} #${activeGitHubProject.number}`
      : 'Choose project'
  const selectedGitHubProjectViewUrl = githubProjectTable
    ? `${githubProjectTable.project.url}/views/${githubProjectTable.selectedView.number}`
    : null
  const githubProjectsByKey = useMemo(
    () => new Map(githubProjects.map((project) => [githubProjectKey(project), project])),
    [githubProjects]
  )
  const pinnedGitHubProjects = useMemo(
    () =>
      githubProjectSettings.pinned.map((project) => ({
        ...project,
        summary: githubProjectsByKey.get(githubProjectKey(project))
      })),
    [githubProjectSettings.pinned, githubProjectsByKey]
  )
  const recentGitHubProjects = useMemo(
    () =>
      githubProjectSettings.recent
        .filter(
          (recent) =>
            !githubProjectSettings.pinned.some(
              (pinned) => githubProjectKey(pinned) === githubProjectKey(recent)
            )
        )
        .map((project) => ({
          ...project,
          summary: githubProjectsByKey.get(githubProjectKey(project))
        })),
    [githubProjectSettings.pinned, githubProjectSettings.recent, githubProjectsByKey]
  )
  const browseGitHubProjects = useMemo(() => {
    const queryText = githubProjectPickerSearch.trim().toLowerCase()
    const pinnedOrRecentKeys = new Set([
      ...githubProjectSettings.pinned.map(githubProjectKey),
      ...githubProjectSettings.recent.map(githubProjectKey)
    ])
    return githubProjects.filter((project) => {
      if (pinnedOrRecentKeys.has(githubProjectKey(project))) {
        return false
      }
      if (!queryText) {
        return true
      }
      return (
        project.title.toLowerCase().includes(queryText) ||
        project.owner.toLowerCase().includes(queryText) ||
        String(project.number).includes(queryText)
      )
    })
  }, [
    githubProjectPickerSearch,
    githubProjectSettings.pinned,
    githubProjectSettings.recent,
    githubProjects
  ])

  const toggleRepoSelection = useCallback(
    (repoId: string) => {
      setSelectedRepoIds((current) => {
        const next = new Set(current)
        if (next.has(repoId)) {
          next.delete(repoId)
        } else {
          next.add(repoId)
        }
        const normalized =
          next.size === 0 || next.size === hostedRepos.length ? new Set<string>() : next
        persistRepoSelection(normalized, hostedRepos)
        return normalized
      })
    },
    [hostedRepos, persistRepoSelection]
  )

  const applyGitHubProjectSearch = useCallback(() => {
    const viewFilter = githubProjectTable?.selectedView.filter ?? ''
    const next = githubProjectSearch
    setAppliedGithubProjectSearch(next === viewFilter ? undefined : next)
  }, [githubProjectSearch, githubProjectTable?.selectedView.filter])

  const headerVerdict = classifyConnection({
    state: connState,
    reconnectAttempts,
    lastConnectedAt
  })
  const emptyLabel =
    connState !== 'connected'
      ? 'Connect to a host to load tasks'
      : query
        ? 'No matching tasks'
        : provider === 'github'
          ? 'No GitHub tasks'
          : provider === 'gitlab'
            ? 'No GitLab tasks'
            : 'No Linear tasks'

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View ref={setTaskCopyFeedbackRootRef} style={styles.topChrome}>
        <View style={styles.statusBar}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={22} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.titleWrap}>
            <StatusDot state={connState} verdict={headerVerdict} />
            <Text style={styles.title}>Tasks</Text>
          </View>
          <Pressable
            style={styles.iconButton}
            disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              if (provider === 'github' && githubMode === 'project') {
                void loadGitHubProjectTable({ queryOverride: appliedGithubProjectSearch })
                return
              }
              void loadTasks({ silent: true })
            }}
          >
            <RefreshCw size={16} color={taskUiReady ? colors.textSecondary : colors.textMuted} />
          </Pressable>
          {showHeaderCreateTask ? (
            <Pressable
              style={styles.iconButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                if (provider === 'linear' && !linearConnected) {
                  setLinearApiKeyDraft('')
                  setLinearConnectState('idle')
                  setLinearConnectError('')
                  setShowLinearConnect(true)
                  return
                }
                setCreateTitle('')
                setCreateBody('')
                setShowCreateTask(true)
              }}
            >
              <Plus size={16} color={taskUiReady ? colors.textSecondary : colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.toolbarScroll}
          contentContainerStyle={styles.toolbar}
        >
          <Pressable
            style={styles.segmentButton}
            disabled={!taskUiReady}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              setShowProviderPicker(true)
            }}
          >
            <TaskProviderLogo provider={provider} size={14} color={colors.textPrimary} />
            <Text style={styles.segmentButtonText}>{providerLabel}</Text>
          </Pressable>

          {provider === 'gitlab' || (provider === 'github' && githubMode !== 'project') ? (
            <Pressable
              style={styles.segmentButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowRepoPicker(true)
              }}
            >
              {repoPickerSelectedRepo ? (
                <View
                  style={[
                    styles.segmentRepoDot,
                    {
                      backgroundColor: getRepoBadgeColor(
                        repoPickerSelectedRepo,
                        repoPickerSelectedRepo.displayName
                      )
                    }
                  ]}
                />
              ) : null}
              <Text style={styles.segmentSecondaryText}>{repoPickerLabel}</Text>
            </Pressable>
          ) : null}

          {provider === 'github' && (
            <>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitHubKindPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>{githubModeLabel}</Text>
              </Pressable>
              {githubMode === 'items' ? (
                <>
                  <Pressable
                    style={styles.segmentButton}
                    disabled={!taskUiReady}
                    onPress={() => {
                      if (!taskUiReady) {
                        return
                      }
                      setShowGitHubPresetPicker(true)
                    }}
                  >
                    <Text style={styles.segmentSecondaryText}>{githubPresetLabel}</Text>
                  </Pressable>
                  {githubIssueSourceRows.length > 0 ? (
                    <Pressable
                      style={styles.segmentButton}
                      disabled={!taskUiReady}
                      onPress={() => {
                        if (!taskUiReady) {
                          return
                        }
                        setShowGitHubIssueSourcePicker(true)
                      }}
                    >
                      <Text style={styles.segmentSecondaryText}>
                        Source: {githubIssueSourceLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : (
                <>
                  <Pressable
                    style={styles.segmentButton}
                    disabled={!taskUiReady}
                    onPress={() => {
                      if (!taskUiReady) {
                        return
                      }
                      setShowGitHubProjectPicker(true)
                    }}
                  >
                    <Text style={styles.segmentSecondaryText}>{activeProjectLabel}</Text>
                  </Pressable>
                  {activeGitHubProjectView ? (
                    <Pressable
                      style={styles.segmentButton}
                      disabled={!taskUiReady}
                      onPress={() => {
                        if (!taskUiReady) {
                          return
                        }
                        setShowGitHubProjectViewPicker(true)
                      }}
                    >
                      <Text style={styles.segmentSecondaryText}>
                        {activeGitHubProjectView.name}
                      </Text>
                    </Pressable>
                  ) : null}
                  {githubProjectTable ? (
                    <Pressable
                      style={styles.segmentButton}
                      disabled={!taskUiReady}
                      onPress={() => {
                        if (!taskUiReady) {
                          return
                        }
                        setShowGitHubProjectSortPicker(true)
                      }}
                    >
                      <Text style={styles.segmentSecondaryText}>
                        Sort: {githubProjectSortLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                  {githubProjectAvailableSummaryFields.length > 0 ? (
                    <Pressable
                      style={styles.segmentButton}
                      disabled={!taskUiReady}
                      onPress={() => {
                        if (!taskUiReady) {
                          return
                        }
                        setShowGitHubProjectFieldsPicker(true)
                      }}
                    >
                      <Text style={styles.segmentSecondaryText}>
                        Fields: {githubProjectFieldsLabel}
                      </Text>
                    </Pressable>
                  ) : null}
                  {githubProjectTable ? (
                    <View style={styles.segmentCountPill}>
                      <Text style={styles.segmentSecondaryText}>
                        {visibleGitHubProjectRows.length}
                      </Text>
                    </View>
                  ) : null}
                  {selectedGitHubProjectViewUrl ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Open view in GitHub"
                      style={styles.segmentIconButton}
                      disabled={!taskUiReady}
                      onPress={() => {
                        if (!taskUiReady) {
                          return
                        }
                        void Linking.openURL(selectedGitHubProjectViewUrl)
                      }}
                    >
                      <ExternalLink size={14} color={colors.textSecondary} />
                    </Pressable>
                  ) : null}
                </>
              )}
            </>
          )}

          {provider === 'gitlab' && (
            <>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowGitLabViewPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>
                  {gitlabView === 'project' ? 'Project MRs' : 'My Todos'}
                </Text>
              </Pressable>
              {gitlabView === 'project' && (
                <Pressable
                  style={styles.segmentButton}
                  disabled={!taskUiReady}
                  onPress={() => {
                    if (!taskUiReady) {
                      return
                    }
                    setShowGitLabFilterPicker(true)
                  }}
                >
                  <Text style={styles.segmentSecondaryText}>{gitlabFilterLabel}</Text>
                </Pressable>
              )}
            </>
          )}

          {provider === 'linear' && linearConnected && (
            <>
              {linearWorkspaces.length > 1 ? (
                <Pressable
                  style={styles.segmentButton}
                  disabled={!taskUiReady}
                  onPress={() => {
                    if (!taskUiReady) {
                      return
                    }
                    setShowLinearWorkspacePicker(true)
                  }}
                >
                  <Text style={styles.segmentSecondaryText}>{linearWorkspaceLabel}</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearTeamPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>{linearTeamLabel}</Text>
              </Pressable>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearFilterPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>{linearFilterLabel}</Text>
              </Pressable>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearViewPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>{linearViewLabel}</Text>
              </Pressable>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearGroupPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>Group: {linearGroupLabel}</Text>
              </Pressable>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearOrderPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>Order: {linearOrderLabel}</Text>
              </Pressable>
              <Pressable
                style={styles.segmentButton}
                disabled={!taskUiReady}
                onPress={() => {
                  if (!taskUiReady) {
                    return
                  }
                  setShowLinearDisplayPicker(true)
                }}
              >
                <Text style={styles.segmentSecondaryText}>Display</Text>
              </Pressable>
            </>
          )}

          {provider !== 'linear' && !(provider === 'github' && githubMode === 'project') ? (
            <Pressable
              style={styles.segmentButton}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowSortPicker(true)
              }}
            >
              <GitBranch size={14} color={colors.textSecondary} />
              <Text style={styles.segmentSecondaryText}>Sort: {sortLabel}</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        {provider === 'gitlab' && gitlabView === 'todos' ? null : provider === 'linear' &&
          !linearConnected ? null : (
          <View style={styles.searchBar}>
            <Search size={14} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={
                provider === 'github' && githubMode === 'project' ? githubProjectSearch : query
              }
              onChangeText={
                provider === 'github' && githubMode === 'project'
                  ? setGithubProjectSearch
                  : setQuery
              }
              placeholder={
                provider === 'github' && githubMode === 'project'
                  ? 'Search project view...'
                  : `Search ${providerLabel} tasks...`
              }
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => {
                if (!taskUiReady) {
                  return
                }
                if (provider === 'github' && githubMode === 'project') {
                  applyGitHubProjectSearch()
                  return
                }
                const nextQuery =
                  provider === 'github' ? scopeGitHubTaskSearch(query, githubKind) : query.trim()
                setQuery(nextQuery)
                setAppliedQuery(nextQuery)
                if (provider === 'github') {
                  persistTaskResumeState({
                    githubItemsPreset:
                      nextQuery.trim() === getTaskPresetQuery(githubPreset) ? githubPreset : null,
                    githubItemsQuery: nextQuery.trim()
                  })
                } else if (provider === 'linear') {
                  persistTaskResumeState({ linearQuery: nextQuery.trim() })
                }
              }}
              onBlur={() => {
                if (provider === 'github' && githubMode === 'project') {
                  applyGitHubProjectSearch()
                }
              }}
            />
            {(provider === 'github' && githubMode === 'project'
              ? githubProjectSearch.length > 0 || appliedGithubProjectSearch !== undefined
              : query.length > 0) && (
              <Pressable
                onPress={() => {
                  if (provider === 'github' && githubMode === 'project') {
                    const viewFilter = githubProjectTable?.selectedView.filter ?? ''
                    setGithubProjectSearch('')
                    setAppliedGithubProjectSearch(viewFilter ? '' : undefined)
                    return
                  }
                  if (provider === 'github') {
                    const nextQuery = getTaskPresetQuery(githubPreset)
                    setQuery(nextQuery)
                    setAppliedQuery(nextQuery)
                    persistTaskResumeState({
                      githubItemsPreset: githubPreset,
                      githubItemsQuery: nextQuery
                    })
                    return
                  }
                  setQuery('')
                  setAppliedQuery('')
                  if (provider === 'linear') {
                    persistTaskResumeState({ linearQuery: '' })
                  }
                }}
              >
                <X size={14} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        )}
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!error && provider === 'github' && githubMode === 'items'
        ? githubSourceFallbacks.map((fallback) => (
            <View
              key={`github-source-fallback:${fallback.repoId}`}
              style={styles.sourceNoticeBanner}
            >
              <Text style={styles.sourceNoticeText}>
                Preferred issue source upstream is unavailable for {fallback.repoLabel}. Using
                origin.
              </Text>
            </View>
          ))
        : null}

      {!error && provider === 'github' && githubMode === 'items'
        ? githubSourceErrors.map((sourceError) => {
            const isRetrying = retryingGithubSourceRepoPaths.has(sourceError.repoPath)
            return (
              <View
                key={`github-source-error:${sourceError.repoId}:${sourceError.source.owner}/${sourceError.source.repo}`}
                style={styles.sourceErrorBanner}
              >
                <View style={styles.sourceErrorCopy}>
                  <Text style={styles.sourceErrorText}>
                    Couldn't load issues from{' '}
                    <Text style={styles.sourceErrorSlug}>
                      {sourceError.source.owner}/{sourceError.source.repo}
                    </Text>
                    .
                  </Text>
                  <Text style={styles.sourceErrorMessage} numberOfLines={2}>
                    {sourceError.message}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Retry loading issues from ${sourceError.source.owner}/${sourceError.source.repo}`}
                  style={styles.sourceErrorRetry}
                  disabled={loading || isRetrying}
                  onPress={() => void retryGitHubIssueSourceFetch(sourceError.repoPath)}
                >
                  <Text style={styles.sourceErrorRetryText}>
                    {isRetrying ? 'Retrying...' : 'Retry'}
                  </Text>
                </Pressable>
              </View>
            )
          })
        : null}

      {!error &&
      provider === 'github' &&
      githubMode === 'project' &&
      githubProjectTable?.parentFieldDropped === true ? (
        <View style={styles.projectDataNotice}>
          <AlertTriangle size={15} color={colors.statusAmber} />
          <Text style={styles.projectDataNoticeText}>
            Sub-issue data is unavailable for your token.
          </Text>
        </View>
      ) : null}

      {!tasksSupported ? (
        tasksUnsupported ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>Update Orca desktop</Text>
            <Text style={styles.centeredHint}>
              This mobile Tasks view needs a newer desktop runtime.
            </Text>
          </View>
        ) : (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        )
      ) : provider === 'linear' && !linearConnected ? (
        <View style={styles.centered}>
          <TaskProviderLogo provider="linear" size={32} color={colors.textSecondary} />
          <Text style={styles.emptyText}>Connect your Linear account</Text>
          <Text style={styles.centeredHint}>
            Browse and start work on your assigned Linear issues directly from Tasks.
          </Text>
          <Pressable
            style={[styles.targetButton, styles.centerActionButton]}
            disabled={!taskUiReady}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              setLinearApiKeyDraft('')
              setLinearConnectState('idle')
              setLinearConnectError('')
              setShowLinearConnect(true)
            }}
          >
            <Text style={styles.targetButtonText}>Connect Linear</Text>
          </Pressable>
        </View>
      ) : provider === 'github' && githubMode === 'project' ? (
        githubProjectLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : !activeGitHubProject ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>Choose a GitHub project</Text>
            <Pressable
              style={[styles.targetButton, styles.centerActionButton]}
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowGitHubProjectPicker(true)
              }}
            >
              <Text style={styles.targetButtonText}>Browse projects</Text>
            </Pressable>
          </View>
        ) : githubProjectError ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>{githubProjectError}</Text>
          </View>
        ) : githubProjectTable && !githubProjectRepoSlugReady ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : !githubProjectTable || visibleGitHubProjectRows.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No project items</Text>
          </View>
        ) : (
          <FlatList
            data={githubProjectListEntries}
            keyExtractor={(entry) =>
              entry.type === 'group' ? `group:${entry.group.key}` : entry.row.id
            }
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
            refreshing={githubProjectLoading}
            onRefresh={() =>
              void loadGitHubProjectTable({ queryOverride: appliedGithubProjectSearch })
            }
            renderItem={({ item: entry }) => {
              if (entry.type === 'group') {
                return (
                  <Pressable
                    style={styles.projectGroupHeader}
                    onPress={() =>
                      setCollapsedGitHubProjectGroups((current) => {
                        const next = new Set(current)
                        if (next.has(entry.group.key)) {
                          next.delete(entry.group.key)
                        } else {
                          next.add(entry.group.key)
                        }
                        return next
                      })
                    }
                  >
                    <ChevronDown
                      size={14}
                      color={colors.textMuted}
                      style={entry.collapsed ? styles.projectGroupChevronCollapsed : undefined}
                    />
                    <Text style={styles.projectGroupTitle} numberOfLines={1}>
                      {entry.group.label || 'Items'}
                    </Text>
                    <Text style={styles.projectGroupMeta}>{projectGroupMeta(entry.group)}</Text>
                  </Pressable>
                )
              }
              const row = entry.row
              const repo = findProjectRowRepo(row)
              return (
                <Pressable
                  style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
                  onPress={() => {
                    triggerMediumImpact()
                    setProjectRowItem(row)
                  }}
                >
                  <View style={styles.taskIcon}>
                    <TaskProviderLogo provider="github" size={15} color={colors.textSecondary} />
                  </View>
                  <View style={styles.taskMain}>
                    <View style={styles.taskTitleRow}>
                      <Text style={styles.taskTitle} numberOfLines={2}>
                        {row.content.title}
                      </Text>
                      <Text style={styles.updatedAt}>{formatUpdatedAt(row.updatedAt)}</Text>
                    </View>
                    <View style={styles.metaRow}>
                      <View
                        style={[
                          styles.repoDot,
                          {
                            backgroundColor: getRepoBadgeColor(
                              repo ?? undefined,
                              row.content.repository ?? 'project'
                            )
                          }
                        ]}
                      />
                      <Text style={styles.subtitle} numberOfLines={1}>
                        {row.itemType === 'PULL_REQUEST'
                          ? 'Pull request'
                          : row.itemType === 'ISSUE'
                            ? 'Issue'
                            : 'Project item'}{' '}
                        · {row.content.repository ?? githubProjectTable.project.title}
                        {row.content.number ? ` #${row.content.number}` : ''}
                      </Text>
                    </View>
                    {githubProjectSummaryFields.length > 0 ? (
                      <View style={styles.projectFieldPillRow}>
                        {githubProjectSummaryFields.slice(0, 4).map((field) => {
                          const value = projectFieldDisplayLabel(row, field)
                          const isEmpty = value === 'Empty'
                          return (
                            <View key={field.id} style={styles.projectFieldPill}>
                              <Text style={styles.projectFieldPillText} numberOfLines={1}>
                                {field.name}:{' '}
                                <Text
                                  style={isEmpty ? styles.projectFieldPillEmptyText : undefined}
                                >
                                  {value}
                                </Text>
                              </Text>
                            </View>
                          )
                        })}
                        {githubProjectSummaryFields.length > 4 ? (
                          <View style={styles.projectFieldPill}>
                            <Text style={styles.projectFieldPillText}>
                              +{githubProjectSummaryFields.length - 4} fields
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusText} numberOfLines={1}>
                      {projectRowStatusLabel(row)}
                    </Text>
                  </View>
                </Pressable>
              )
            }}
          />
        )
      ) : provider === 'linear' ? (
        loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : linearIssuesForView.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>{emptyLabel}</Text>
          </View>
        ) : linearViewMode === 'board' ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[
              styles.boardContainer,
              { paddingBottom: spacing.lg + insets.bottom }
            ]}
          >
            {linearBoardSections.map((section) => (
              <View key={section.key} style={styles.boardColumn}>
                <View style={styles.boardHeader}>
                  <View style={[styles.repoSectionDot, { backgroundColor: section.color }]} />
                  <Text style={styles.boardTitle} numberOfLines={1}>
                    {section.label}
                  </Text>
                  <Text style={styles.boardCount}>{section.issues.length}</Text>
                </View>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {section.issues.map((issue) => (
                    <Pressable
                      key={issue.id}
                      style={({ pressed }) => [styles.boardCard, pressed && styles.taskRowPressed]}
                      onPress={() => {
                        triggerMediumImpact()
                        setActionItem(
                          createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
                        )
                      }}
                    >
                      <Text style={styles.taskTitle} numberOfLines={3}>
                        {issue.title}
                      </Text>
                      <Text style={styles.subtitle} numberOfLines={2}>
                        {linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties).join(
                          ' · '
                        )}
                      </Text>
                      {effectiveLinearDisplayProperties.has('state') ? (
                        <Pressable
                          style={[styles.statusPillSelf, styles.linearStatePill]}
                          disabled={mutatingStatus}
                          accessibilityRole="button"
                          accessibilityLabel={`Change status from ${issue.state.name}`}
                          onPress={(event) => {
                            event.stopPropagation()
                            triggerMediumImpact()
                            setLinearStatusPickerItem(
                              createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
                            )
                          }}
                        >
                          <View
                            style={[
                              styles.linearStateDot,
                              { backgroundColor: issue.state.color || colors.textMuted }
                            ]}
                          />
                          <Text
                            style={[styles.statusText, styles.statusTextFlex]}
                            numberOfLines={1}
                          >
                            {issue.state.name}
                          </Text>
                          <ChevronDown size={12} color={colors.textSecondary} />
                        </Pressable>
                      ) : null}
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ))}
          </ScrollView>
        ) : (
          <FlatList
            data={linearListEntries}
            keyExtractor={(entry) =>
              entry.type === 'section' ? `linear-section:${entry.section.key}` : entry.issue.id
            }
            ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
              leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
                <View style={styles.separator} />
              )
            }
            contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
            refreshing={refreshing}
            onRefresh={() => void loadTasks({ silent: true })}
            renderItem={({ item: entry }) => {
              if (entry.type === 'section') {
                return (
                  <View style={styles.repoSectionHeader}>
                    <View
                      style={[styles.repoSectionDot, { backgroundColor: entry.section.color }]}
                    />
                    <Text style={styles.repoSectionTitle} numberOfLines={1}>
                      {entry.section.label}
                    </Text>
                    <Text style={styles.boardCount}>{entry.section.issues.length}</Text>
                  </View>
                )
              }
              const issue = entry.issue
              const linearTask = createLinearTask(issue) as Extract<
                TaskItem,
                { provider: 'linear' }
              >
              return (
                <Pressable
                  style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
                  onPress={() => {
                    triggerMediumImpact()
                    setActionItem(linearTask)
                  }}
                >
                  <View style={styles.taskIcon}>
                    <TaskProviderLogo provider="linear" size={15} color={colors.textSecondary} />
                  </View>
                  <View style={styles.taskMain}>
                    <View style={styles.taskTitleRow}>
                      <Text style={styles.taskTitle} numberOfLines={2}>
                        {issue.title}
                      </Text>
                      {effectiveLinearDisplayProperties.has('updated') ? (
                        <Text style={styles.updatedAt}>{formatUpdatedAt(issue.updatedAt)}</Text>
                      ) : null}
                    </View>
                    <View style={styles.metaRow}>
                      <View style={[styles.repoDot, { backgroundColor: issue.state.color }]} />
                      <Text style={styles.subtitle} numberOfLines={1}>
                        {linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties).join(
                          ' · '
                        )}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.linearListTrailing}>
                    {effectiveLinearDisplayProperties.has('state') ? (
                      <Pressable
                        style={[styles.statusPill, styles.linearStatePill]}
                        disabled={mutatingStatus}
                        accessibilityRole="button"
                        accessibilityLabel={`Change status from ${issue.state.name}`}
                        onPress={(event) => {
                          event.stopPropagation()
                          triggerMediumImpact()
                          setLinearStatusPickerItem(linearTask)
                        }}
                      >
                        <View
                          style={[
                            styles.linearStateDot,
                            { backgroundColor: issue.state.color || colors.textMuted }
                          ]}
                        />
                        <Text style={[styles.statusText, styles.statusTextFlex]} numberOfLines={1}>
                          {issue.state.name}
                        </Text>
                        <ChevronDown size={12} color={colors.textSecondary} />
                      </Pressable>
                    ) : null}
                  </View>
                </Pressable>
              )
            }}
          />
        )
      ) : loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : sortedItems.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>{emptyLabel}</Text>
        </View>
      ) : (
        <FlatList
          data={displayedEntries}
          keyExtractor={(entry) => entry.key}
          ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
            leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
              <View style={styles.separator} />
            )
          }
          contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
          refreshing={refreshing}
          onRefresh={() => void loadTasks({ silent: true })}
          ListFooterComponent={
            provider === 'github' && githubMode === 'items' && githubCanShowPagination ? (
              <View style={styles.paginationFooter}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Previous page"
                  accessibilityState={{
                    disabled: githubCurrentPage === 0 || githubPaginationLoading
                  }}
                  style={[
                    styles.paginationButton,
                    (githubCurrentPage === 0 || githubPaginationLoading) &&
                      styles.paginationButtonDisabled
                  ]}
                  disabled={githubCurrentPage === 0 || githubPaginationLoading}
                  onPress={() => void handleGitHubPageChange(githubCurrentPage - 1)}
                >
                  <ChevronLeft size={17} color={colors.textPrimary} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    githubTotalCount === null
                      ? `Select page, Page ${githubCurrentPage + 1}`
                      : `Select page, Page ${githubCurrentPage + 1} of ${githubTotalPages}`
                  }
                  accessibilityState={{ disabled: githubPaginationLoading }}
                  style={styles.paginationLabelButton}
                  disabled={githubPaginationLoading}
                  onPress={() => {
                    if (!taskUiReady) {
                      return
                    }
                    setShowGitHubPagePicker(true)
                  }}
                >
                  <Text style={styles.paginationLabel}>
                    {githubTotalCount === null
                      ? `Page ${githubCurrentPage + 1}`
                      : `Page ${githubCurrentPage + 1} of ${githubTotalPages}`}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Next page"
                  accessibilityState={{
                    disabled:
                      (!githubCanLoadUncountedNextPage &&
                        githubCurrentPage >= githubTotalPages - 1) ||
                      githubPaginationLoading
                  }}
                  style={[
                    styles.paginationButton,
                    ((!githubCanLoadUncountedNextPage &&
                      githubCurrentPage >= githubTotalPages - 1) ||
                      githubPaginationLoading) &&
                      styles.paginationButtonDisabled
                  ]}
                  disabled={
                    (!githubCanLoadUncountedNextPage &&
                      githubCurrentPage >= githubTotalPages - 1) ||
                    githubPaginationLoading
                  }
                  onPress={() => void handleGitHubPageChange(githubCurrentPage + 1)}
                >
                  {githubLoadingTargetPage === githubCurrentPage + 1 ? (
                    <ActivityIndicator size="small" color={colors.textPrimary} />
                  ) : (
                    <ChevronRight size={17} color={colors.textPrimary} />
                  )}
                </Pressable>
              </View>
            ) : null
          }
          renderItem={({ item: entry }) => {
            if (entry.type === 'section') {
              return (
                <View style={styles.repoSectionHeader}>
                  <View style={[styles.repoSectionDot, { backgroundColor: entry.color }]} />
                  <Text style={styles.repoSectionTitle} numberOfLines={1}>
                    {entry.label}
                  </Text>
                </View>
              )
            }
            const item = entry.item
            const repo = taskRepositoryMeta(item, reposById)
            const isGitHubPr = item.provider === 'github' && item.source.type === 'pr'
            const githubPrDelta = isGitHubPr ? formatGitHubPRDelta(item.source) : null
            const branchSummary = hostedBranchSummary(item)
            return (
              <Pressable
                style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
                onPress={() => {
                  triggerMediumImpact()
                  if (item.provider === 'gitlabTodo') {
                    void Linking.openURL(item.source.targetUrl)
                    return
                  }
                  setActionItem(item)
                }}
              >
                <View style={styles.taskIcon}>
                  <TaskProviderLogo
                    provider={item.provider === 'gitlabTodo' ? 'gitlab' : item.provider}
                    size={15}
                    color={colors.textSecondary}
                  />
                </View>
                <View style={styles.taskMain}>
                  <View style={styles.taskTitleRow}>
                    <Text style={styles.taskTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={styles.updatedAt}>{formatUpdatedAt(item.updatedAt)}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <View style={[styles.repoDot, { backgroundColor: repo.color }]} />
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {taskKindLabel(item)} · {item.subtitle}
                    </Text>
                  </View>
                  {branchSummary ? (
                    <View style={styles.branchMetaRow}>
                      <GitBranch size={11} color={colors.textMuted} />
                      <Text style={styles.branchMetaText} numberOfLines={1}>
                        {branchSummary.head}
                      </Text>
                      <Text style={styles.branchMetaBase} numberOfLines={1}>
                        into {branchSummary.base}
                      </Text>
                    </View>
                  ) : null}
                  {isGitHubPr ? (
                    <View style={styles.prSignalRow}>
                      {githubPrDelta ? (
                        <View style={styles.prSignalChip}>
                          <Text style={styles.prSignalText} numberOfLines={1}>
                            {githubPrDelta}
                          </Text>
                        </View>
                      ) : null}
                      <View
                        style={[
                          styles.prSignalChip,
                          getPrSignalToneStyle(getGitHubPRSignalTone(item.source, 'review'))
                        ]}
                      >
                        <Text style={styles.prSignalText} numberOfLines={1}>
                          {getGitHubReviewSummary(item.source)}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.prSignalChip,
                          getPrSignalToneStyle(getGitHubPRSignalTone(item.source, 'checks'))
                        ]}
                      >
                        <Text style={styles.prSignalText} numberOfLines={1}>
                          {getGitHubChecksLabel(item.source)}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.prSignalChip,
                          getPrSignalToneStyle(getGitHubPRSignalTone(item.source, 'merge'))
                        ]}
                      >
                        <Text style={styles.prSignalText} numberOfLines={1}>
                          {getGitHubMergeLabel(item.source)}
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </View>
                <View style={styles.taskRowTrailing}>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusText} numberOfLines={1}>
                      {item.status}
                    </Text>
                  </View>
                </View>
              </Pressable>
            )
          }}
        />
      )}

      <PickerModal
        visible={taskUiReady && showProviderPicker}
        title="Task Source"
        options={providerOptions}
        selected={provider}
        onSelect={(next) => {
          const resume = taskResumeRef.current
          persistTaskSource(next)
          setProvider(next)
          setItems([])
          if (next === 'github') {
            const nextMode = resume.githubMode === 'project' ? 'project' : 'items'
            setGithubMode(nextMode)
            if (nextMode === 'project') {
              setQuery('')
              setAppliedQuery('')
              return
            }
            const preset =
              resume.githubItemsPreset === null
                ? githubPreset
                : normalizeGitHubPreset(resume.githubItemsPreset ?? githubPreset)
            const nextQuery =
              resume.githubItemsPreset === null
                ? (resume.githubItemsQuery ?? '')
                : getTaskPresetQuery(preset)
            const nextKind = githubKindFromQuery(nextQuery, preset)
            setGithubPreset(preset)
            setGithubKind(nextKind)
            setQuery(nextQuery)
            setAppliedQuery(scopeGitHubTaskSearch(nextQuery, nextKind))
          } else if (next === 'linear') {
            const nextQuery = resume.linearQuery ?? ''
            setLinearFilter(normalizeLinearFilter(resume.linearPreset))
            setQuery(nextQuery)
            setAppliedQuery(nextQuery.trim())
          } else {
            setQuery('')
            setAppliedQuery('')
          }
        }}
        onClose={() => setShowProviderPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showRepoPicker}
        onClose={() => setShowRepoPicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Repositories</Text>
          <Text style={styles.sheetSubtitle}>Choose which repositories to query.</Text>
        </View>

        <View style={styles.repoPickerGroup}>
          <Pressable
            style={styles.repoPickerRow}
            onPress={() => {
              const allSelection = new Set<string>()
              setSelectedRepoIds(allSelection)
              persistRepoSelection(allSelection, hostedRepos)
            }}
          >
            <View style={styles.repoPickerTextWrap}>
              <Text style={styles.repoPickerTitle}>All repositories</Text>
              <Text style={styles.repoPickerSubtitle}>{repositoryCount(hostedRepos.length)}</Text>
            </View>
            {selectedRepoIds.size === 0 ? <Check size={15} color={colors.textPrimary} /> : null}
          </Pressable>

          {hostedRepos.map((repo) => {
            const selected = selectedRepoIds.has(repo.id)
            return (
              <View key={repo.id}>
                <View style={styles.actionSeparator} />
                <Pressable
                  style={styles.repoPickerRow}
                  onPress={() => toggleRepoSelection(repo.id)}
                >
                  <View
                    style={[
                      styles.pickerRepoDot,
                      { backgroundColor: getRepoBadgeColor(repo, repo.displayName) }
                    ]}
                  />
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle} numberOfLines={1}>
                      {repo.displayName}
                    </Text>
                    <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                      {repo.path}
                    </Text>
                  </View>
                  {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                </Pressable>
              </View>
            )
          })}
        </View>
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && showGitHubIssueSourcePicker}
        onClose={() => setShowGitHubIssueSourcePicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>GitHub Issue Sources</Text>
          <Text style={styles.sheetSubtitle}>
            Choose whether each repository queries and creates work from upstream or origin.
          </Text>
        </View>

        <View style={styles.repoPickerGroup}>
          {githubIssueSourceRows.length === 0 ? (
            <View style={styles.drawerLoadingRow}>
              <Text style={styles.detailMuted}>No alternate issue sources available.</Text>
            </View>
          ) : (
            githubIssueSourceRows.map(({ repo, sources }, index) => {
              const selectedPreference =
                repo.issueSourcePreference === 'origin' || repo.issueSourcePreference === 'upstream'
                  ? repo.issueSourcePreference
                  : 'upstream'
              return (
                <View key={repo.id}>
                  {index > 0 ? <View style={styles.actionSeparator} /> : null}
                  <View style={styles.issueSourceBox}>
                    <View style={styles.repoPickerTextWrap}>
                      <Text style={styles.repoPickerTitle} numberOfLines={1}>
                        {repo.displayName}
                      </Text>
                      <Text style={styles.issueSourceHint} numberOfLines={2}>
                        Querying{' '}
                        {issueSourceSlug(
                          selectedPreference === 'origin' ? sources.prs : sources.upstreamCandidate
                        )}
                      </Text>
                    </View>
                    <View style={styles.issueSourceSegment}>
                      {(['upstream', 'origin'] as const).map((preference) => {
                        const selected = selectedPreference === preference
                        const slug =
                          preference === 'upstream'
                            ? issueSourceSlug(sources.upstreamCandidate)
                            : issueSourceSlug(sources.prs)
                        return (
                          <Pressable
                            key={preference}
                            style={[
                              styles.issueSourceSegmentButton,
                              selected && styles.issueSourceSegmentButtonActive
                            ]}
                            accessibilityState={{ selected }}
                            onPress={() => void setGitHubIssueSourcePreference(repo, preference)}
                          >
                            <Text
                              style={[
                                styles.issueSourceSegmentText,
                                selected && styles.issueSourceSegmentTextActive
                              ]}
                            >
                              {preference === 'upstream' ? 'Upstream' : 'Origin'}
                            </Text>
                            <Text style={styles.issueSourceSlug} numberOfLines={1}>
                              {slug}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  </View>
                </View>
              )
            })
          )}
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showGitHubKindPicker}
        title="GitHub View"
        options={GITHUB_KIND_OPTIONS}
        selected={githubMode === 'project' ? 'project' : githubKind}
        onSelect={(kind) => {
          if (kind === 'project') {
            setGithubMode('project')
            setItems([])
            persistTaskResumeState({ githubMode: 'project' })
            return
          }
          const preset = kind === 'prs' ? 'prs' : 'issues'
          const nextQuery = getTaskPresetQuery(preset)
          setGithubMode('items')
          setGithubKind(kind)
          setGithubPreset(preset)
          setQuery(nextQuery)
          setAppliedQuery(nextQuery)
          persistTaskResumeState({
            githubMode: 'items',
            githubItemsPreset: preset,
            githubItemsQuery: nextQuery
          })
        }}
        onClose={() => setShowGitHubKindPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showGitHubPresetPicker}
        title={githubKind === 'prs' ? 'Pull Requests' : 'Issues'}
        options={githubPresetPickerOptions}
        selected={githubPreset}
        onSelect={(preset) => {
          const nextQuery = getTaskPresetQuery(preset)
          setGithubMode('items')
          setGithubKind(preset === 'issues' || preset === 'my-issues' ? 'issues' : 'prs')
          setGithubPreset(preset)
          setQuery(nextQuery)
          setAppliedQuery(nextQuery)
          persistTaskResumeState({
            githubItemsPreset: preset,
            githubItemsQuery: nextQuery
          })
        }}
        onLongSelect={persistDefaultGitHubPreset}
        onClose={() => setShowGitHubPresetPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showGitHubPagePicker}
        onClose={() => setShowGitHubPagePicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>GitHub Pages</Text>
          <Text style={styles.sheetSubtitle}>Jump to a loaded or available result page.</Text>
        </View>
        <ScrollView style={styles.pagePickerList}>
          {githubPagePickerPages.map((index) => {
            const selected = index === githubCurrentPage
            const loaded = index < githubPages.length
            return (
              <Pressable
                key={`github-page:${index}`}
                style={[styles.pickerRow, selected && styles.pickerRowSelected]}
                disabled={githubPaginationLoading}
                onPress={() => {
                  setShowGitHubPagePicker(false)
                  void handleGitHubPageChange(index)
                }}
              >
                <View style={styles.pickerRowContent}>
                  <Text style={styles.pickerRowLabel}>Page {index + 1}</Text>
                  <Text style={styles.pickerRowSubtitle}>
                    {loaded ? 'Loaded' : 'Loads older results'}
                  </Text>
                </View>
                {selected ? <Check size={16} color={colors.textPrimary} /> : null}
              </Pressable>
            )
          })}
        </ScrollView>
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && showGitHubProjectPicker}
        onClose={() => setShowGitHubProjectPicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>GitHub Projects</Text>
          <Text style={styles.sheetSubtitle}>Choose a project view for the Tasks page.</Text>
        </View>

        <View style={styles.projectPickerControls}>
          <TextInput
            style={styles.input}
            value={githubProjectPickerSearch}
            onChangeText={setGithubProjectPickerSearch}
            placeholder="Search projects"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.projectPasteRow}>
            <TextInput
              style={[styles.input, styles.projectPasteInput]}
              value={githubProjectPasteInput}
              onChangeText={(next) => {
                setGithubProjectPasteInput(next)
                setGithubProjectPasteError('')
              }}
              onSubmitEditing={() => void resolveGitHubProjectFromInput()}
              placeholder="Add by URL or owner/number"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={[styles.inlineSaveButtonCompact, styles.projectPasteButton]}
              disabled={githubProjectPasteBusy || githubProjectPasteInput.trim().length === 0}
              onPress={() => void resolveGitHubProjectFromInput()}
            >
              <Text style={styles.inlineSaveText}>
                {githubProjectPasteBusy ? 'Adding...' : 'Add'}
              </Text>
            </Pressable>
          </View>
          {githubProjectPasteError ? (
            <Text style={styles.detailError}>{githubProjectPasteError}</Text>
          ) : null}
        </View>

        {githubProjectError ? <Text style={styles.detailError}>{githubProjectError}</Text> : null}

        {githubProjectPartialFailures.length > 0 ? (
          <View style={styles.projectWarningBanner}>
            <AlertTriangle size={15} color={colors.statusAmber} />
            <View style={styles.projectWarningTextWrap}>
              <Text style={styles.projectWarningTitle}>
                {githubProjectPartialFailures.length === 1 &&
                githubProjectPartialFailures[0]!.owner !== '*'
                  ? `Couldn't load projects from ${githubProjectPartialFailures[0]!.owner}.`
                  : `Some organizations didn't load (${githubProjectPartialFailures.length}).`}
              </Text>
              <Text style={styles.projectWarningText}>
                Use Add by URL to reach missing projects.
              </Text>
              <Text style={styles.projectWarningText} numberOfLines={2}>
                {githubProjectPartialFailures
                  .map(
                    (failure) =>
                      `${failure.owner === '*' ? 'orgs' : failure.owner}: ${failure.message}`
                  )
                  .join(' · ')}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.repoPickerGroup}>
          {githubProjectLoading && githubProjects.length === 0 ? (
            <View style={styles.drawerLoadingRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : githubProjects.length === 0 &&
            pinnedGitHubProjects.length === 0 &&
            recentGitHubProjects.length === 0 ? (
            <Pressable
              style={styles.repoPickerRow}
              onPress={() =>
                void loadGitHubProjects().catch((err) => {
                  setGithubProjectError(
                    err instanceof Error ? err.message : 'Failed to load projects'
                  )
                })
              }
            >
              <View style={styles.repoPickerTextWrap}>
                <Text style={styles.repoPickerTitle}>No projects loaded</Text>
                <Text style={styles.repoPickerSubtitle}>Tap to retry.</Text>
              </View>
            </Pressable>
          ) : (
            <>
              {pinnedGitHubProjects.length > 0 ? (
                <>
                  <Text style={styles.linearStatesTitle}>Pinned</Text>
                  {pinnedGitHubProjects.map((project, index) => {
                    const key = githubProjectKey(project)
                    const selected =
                      activeGitHubProject !== null && githubProjectKey(activeGitHubProject) === key
                    return (
                      <View key={`pinned:${key}`}>
                        {index > 0 ? <View style={styles.actionSeparator} /> : null}
                        <Pressable
                          style={styles.repoPickerRow}
                          onPress={() => {
                            setShowGitHubProjectPicker(false)
                            void selectGitHubProject(project)
                          }}
                        >
                          <View style={styles.repoPickerTextWrap}>
                            <Text style={styles.repoPickerTitle} numberOfLines={1}>
                              {project.summary?.title ?? `#${project.number}`}
                            </Text>
                            <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                              {project.owner} · #{project.number}
                            </Text>
                          </View>
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            onPress={(event) => {
                              event.stopPropagation()
                              persistGitHubProjectSettings({
                                ...githubProjectSettings,
                                pinned: githubProjectSettings.pinned.filter(
                                  (entry) => githubProjectKey(entry) !== key
                                )
                              })
                            }}
                          >
                            <Text style={styles.inlineSaveText}>Remove</Text>
                          </Pressable>
                          {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                        </Pressable>
                      </View>
                    )
                  })}
                </>
              ) : null}

              {recentGitHubProjects.length > 0 ? (
                <>
                  <Text style={styles.linearStatesTitle}>Recent</Text>
                  {recentGitHubProjects.map((project, index) => {
                    const key = githubProjectKey(project)
                    const selected =
                      activeGitHubProject !== null && githubProjectKey(activeGitHubProject) === key
                    return (
                      <View key={`recent:${key}`}>
                        {index > 0 ? <View style={styles.actionSeparator} /> : null}
                        <Pressable
                          style={styles.repoPickerRow}
                          onPress={() => {
                            setShowGitHubProjectPicker(false)
                            void selectGitHubProject(project)
                          }}
                        >
                          <View style={styles.repoPickerTextWrap}>
                            <Text style={styles.repoPickerTitle} numberOfLines={1}>
                              {project.summary?.title ?? `#${project.number}`}
                            </Text>
                            <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                              {project.owner} · #{project.number}
                            </Text>
                          </View>
                          {githubProjectSettings.lastViewByProject[key]?.viewId ? (
                            <Pressable
                              style={styles.inlineSaveButtonCompact}
                              onPress={(event) => {
                                event.stopPropagation()
                                persistGitHubProjectSettings({
                                  ...githubProjectSettings,
                                  pinned: [
                                    ...githubProjectSettings.pinned,
                                    {
                                      owner: project.owner,
                                      ownerType: project.ownerType,
                                      number: project.number
                                    }
                                  ].slice(0, 20)
                                })
                              }}
                            >
                              <Text style={styles.inlineSaveText}>Pin</Text>
                            </Pressable>
                          ) : null}
                          {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                        </Pressable>
                      </View>
                    )
                  })}
                </>
              ) : null}

              <Text style={styles.linearStatesTitle}>
                {githubProjectLoading ? 'Browse all (loading...)' : 'Browse all'}
              </Text>
              {browseGitHubProjects.length === 0 ? (
                <Text style={styles.emptyInlineText}>
                  {githubProjectPickerSearch.trim() ? 'No matching projects.' : 'No more projects.'}
                </Text>
              ) : (
                browseGitHubProjects.map((project, index) => {
                  const selected =
                    activeGitHubProject !== null &&
                    githubProjectKey(activeGitHubProject) === githubProjectKey(project)
                  return (
                    <View key={project.id}>
                      {index > 0 ? <View style={styles.actionSeparator} /> : null}
                      <Pressable
                        style={styles.repoPickerRow}
                        onPress={() => {
                          setShowGitHubProjectPicker(false)
                          void selectGitHubProject(project)
                        }}
                      >
                        <View style={styles.repoPickerTextWrap}>
                          <Text style={styles.repoPickerTitle} numberOfLines={1}>
                            {project.title}
                          </Text>
                          <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                            {project.owner} · #{project.number}
                          </Text>
                        </View>
                        {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                      </Pressable>
                    </View>
                  )
                })
              )}
            </>
          )}
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showGitHubProjectViewPicker}
        title={pendingGitHubProjectViewSelection ? 'Choose Project View' : 'Project View'}
        options={githubProjectViewOptions}
        selected={pendingGitHubProjectViewSelection ? '' : (activeGitHubProjectViewId ?? '')}
        onSelect={(viewId) => {
          const view = githubProjectViews.find((candidate) => candidate.id === viewId)
          if (view && view.layout !== 'TABLE_LAYOUT') {
            setGithubProjectError("Orca doesn't support this GitHub Project layout yet.")
            return
          }
          if (pendingGitHubProjectViewSelection) {
            commitGitHubProjectView(pendingGitHubProjectViewSelection, viewId)
            setPendingGitHubProjectViewSelection(null)
            return
          }
          if (!activeGitHubProject || !activeGitHubProjectKey) {
            return
          }
          commitGitHubProjectView(activeGitHubProject, viewId)
        }}
        onClose={() => {
          setShowGitHubProjectViewPicker(false)
          if (pendingGitHubProjectViewSelection) {
            setPendingGitHubProjectViewSelection(null)
          }
        }}
      />

      <PickerModal
        visible={taskUiReady && showGitHubProjectSortPicker}
        title="Project Sort"
        options={githubProjectSortOptions}
        selected={githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT}
        onSelect={(fieldId) => {
          if (fieldId === PROJECT_VIEW_DEFAULT_SORT) {
            setGithubProjectSortOverride(null)
            return
          }
          setGithubProjectSortOverride((current) => {
            if (!current || current.fieldId !== fieldId) {
              return { fieldId, direction: 'ASC' }
            }
            if (current.direction === 'ASC') {
              return { fieldId, direction: 'DESC' }
            }
            return null
          })
        }}
        onClose={() => setShowGitHubProjectSortPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showGitHubProjectFieldsPicker}
        onClose={() => setShowGitHubProjectFieldsPicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Project Fields</Text>
          <Text style={styles.sheetSubtitle}>
            Choose which Project fields appear on item cards.
          </Text>
        </View>
        <View style={styles.repoPickerGroup}>
          {githubProjectAvailableSummaryFields.length === 0 ? (
            <Text style={styles.repoPickerSubtitle}>This view has no extra fields to show.</Text>
          ) : (
            githubProjectAvailableSummaryFields.map((field, index) => {
              const visible = !githubProjectHiddenFieldIds.has(field.id)
              return (
                <View key={field.id}>
                  {index > 0 ? <View style={styles.actionSeparator} /> : null}
                  <Pressable
                    style={styles.repoPickerRow}
                    onPress={() => toggleGitHubProjectFieldVisibility(field.id)}
                  >
                    <View style={styles.repoPickerTextWrap}>
                      <Text style={styles.repoPickerTitle} numberOfLines={1}>
                        {field.name}
                      </Text>
                      <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                        {visible ? 'Shown on cards' : 'Hidden from cards'}
                      </Text>
                    </View>
                    {visible ? <Check size={15} color={colors.textPrimary} /> : null}
                  </Pressable>
                </View>
              )
            })
          )}
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showGitLabViewPicker}
        title="GitLab View"
        options={GITLAB_VIEW_OPTIONS}
        selected={gitlabView}
        onSelect={(view) => {
          setGitlabView(view)
          if (view === 'todos') {
            // Why: GitLab Todos is a server-side pending-todos stream; the
            // runtime method has no search query, so clear item-search state
            // when entering that view instead of carrying an invisible filter.
            setQuery('')
            setAppliedQuery('')
          }
        }}
        onClose={() => setShowGitLabViewPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showGitLabFilterPicker}
        title="GitLab Filter"
        options={GITLAB_FILTER_OPTIONS}
        selected={gitlabFilter}
        onSelect={setGitlabFilter}
        onClose={() => setShowGitLabFilterPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showLinearFilterPicker}
        title="Linear Filter"
        options={LINEAR_FILTER_OPTIONS}
        selected={linearFilter}
        onSelect={(filter) => {
          setLinearFilter(filter)
          setQuery('')
          setAppliedQuery('')
          persistTaskResumeState({ linearPreset: filter, linearQuery: '' })
        }}
        onClose={() => setShowLinearFilterPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showLinearWorkspacePicker}
        title="Linear Workspace"
        options={linearWorkspaceOptions}
        selected={selectedLinearWorkspaceId ?? ''}
        onSelect={(workspaceId) => {
          setSelectedLinearWorkspaceId(workspaceId)
          setSelectedLinearTeamIds(new Set())
          if (client) {
            void client
              .sendRequest('linear.selectWorkspace', { workspaceId })
              .then(() => loadLinearContext())
              .catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to switch workspace')
              })
          }
        }}
        onClose={() => setShowLinearWorkspacePicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showLinearTeamPicker}
        onClose={() => setShowLinearTeamPicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Linear Teams</Text>
          <Text style={styles.sheetSubtitle}>Choose which teams appear in Tasks.</Text>
        </View>
        <View style={styles.repoPickerGroup}>
          <Pressable
            style={styles.repoPickerRow}
            onPress={() => {
              const next = new Set(linearTeams.map((team) => team.id))
              setSelectedLinearTeamIds(next)
              persistLinearTeamSelection(next, linearTeams)
            }}
          >
            <View style={styles.repoPickerTextWrap}>
              <Text style={styles.repoPickerTitle}>All teams</Text>
              <Text style={styles.repoPickerSubtitle}>{linearTeams.length} teams</Text>
            </View>
            {selectedLinearTeamIds.size === linearTeams.length ? (
              <Check size={15} color={colors.textPrimary} />
            ) : null}
          </Pressable>
          {linearTeams.map((team) => {
            const selected = selectedLinearTeamIds.has(team.id)
            return (
              <View key={team.id}>
                <View style={styles.actionSeparator} />
                <Pressable
                  style={styles.repoPickerRow}
                  onPress={() => {
                    const next = new Set(selectedLinearTeamIds)
                    if (next.has(team.id)) {
                      next.delete(team.id)
                    } else {
                      next.add(team.id)
                    }
                    const normalized =
                      next.size === 0 || next.size === linearTeams.length
                        ? new Set(linearTeams.map((entry) => entry.id))
                        : next
                    setSelectedLinearTeamIds(normalized)
                    persistLinearTeamSelection(normalized, linearTeams)
                  }}
                >
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle} numberOfLines={1}>
                      {team.name}
                    </Text>
                    <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                      {team.workspaceName ?? team.key}
                    </Text>
                  </View>
                  {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                </Pressable>
              </View>
            )
          })}
        </View>
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && linearStatusPickerItem !== null}
        onClose={() => setLinearStatusPickerItem(null)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Change Status</Text>
          <Text style={styles.sheetSubtitle}>
            {linearStatusPickerItem?.source.identifier ?? 'Linear issue'}
          </Text>
        </View>
        <View style={styles.repoPickerGroup}>
          {linearStatesLoading ? (
            <View style={styles.detailLoadingInline}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.detailMuted}>Loading states...</Text>
            </View>
          ) : linearStates.length === 0 ? (
            <Text style={styles.emptyInlineText}>No states available</Text>
          ) : (
            linearStates.map((state, index) => {
              const selected =
                state.name === linearStatusPickerItem?.source.state.name &&
                state.type === linearStatusPickerItem?.source.state.type
              return (
                <View key={state.id}>
                  {index > 0 ? <View style={styles.actionSeparator} /> : null}
                  <Pressable
                    style={styles.repoPickerRow}
                    disabled={mutatingStatus}
                    onPress={() => {
                      if (!linearStatusPickerItem) {
                        return
                      }
                      void setLinearStatus(linearStatusPickerItem, state, {
                        closeDetail: false
                      }).then(() => setLinearStatusPickerItem(null))
                    }}
                  >
                    <View
                      style={[
                        styles.pickerRepoDot,
                        { backgroundColor: state.color || colors.textMuted }
                      ]}
                    />
                    <View style={styles.repoPickerTextWrap}>
                      <Text style={styles.repoPickerTitle} numberOfLines={1}>
                        {state.name}
                      </Text>
                      <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                        {state.type}
                      </Text>
                    </View>
                    {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                  </Pressable>
                </View>
              )
            })
          )}
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showLinearViewPicker}
        title="Linear View"
        options={LINEAR_VIEW_OPTIONS}
        selected={linearViewMode}
        onSelect={setLinearViewMode}
        onClose={() => setShowLinearViewPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showLinearGroupPicker}
        title="Group Linear Issues"
        options={LINEAR_GROUP_OPTIONS}
        selected={linearGroupBy}
        onSelect={setLinearGroupBy}
        onClose={() => setShowLinearGroupPicker(false)}
      />

      <PickerModal
        visible={taskUiReady && showLinearOrderPicker}
        title="Order Linear Issues"
        options={LINEAR_ORDER_OPTIONS}
        selected={linearOrderBy}
        onSelect={setLinearOrderBy}
        onClose={() => setShowLinearOrderPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showLinearDisplayPicker}
        onClose={() => setShowLinearDisplayPicker(false)}
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Display Properties</Text>
        </View>
        <View style={styles.repoPickerGroup}>
          {LINEAR_DISPLAY_OPTIONS.map((property, index) => {
            const selected = effectiveLinearDisplayProperties.has(property.value)
            return (
              <View key={property.value}>
                {index > 0 ? <View style={styles.actionSeparator} /> : null}
                <Pressable
                  style={styles.repoPickerRow}
                  onPress={() => {
                    if (property.value === 'team') {
                      setLinearTeamPropertyTouched(true)
                    }
                    setLinearDisplayProperties((current) => {
                      const next = new Set(current)
                      if (next.has(property.value)) {
                        next.delete(property.value)
                      } else {
                        next.add(property.value)
                      }
                      return next
                    })
                  }}
                >
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle}>{property.label}</Text>
                  </View>
                  {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                </Pressable>
              </View>
            )
          })}
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showSortPicker}
        title="Sort Tasks"
        options={SORT_OPTIONS}
        selected={taskSort}
        onSelect={setTaskSort}
        onClose={() => setShowSortPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showCreateTask}
        onClose={() => {
          setShowCreateTargetPicker(false)
          setShowCreateTask(false)
        }}
      >
        <View style={styles.sheetHeader}>
          <View style={styles.sheetTitleRow}>
            <TaskProviderLogo provider={provider} size={16} color={colors.textPrimary} />
            <Text style={styles.sheetTitle}>New {providerLabel} Issue</Text>
          </View>
          <Text style={styles.sheetSubtitle}>
            {provider === 'github' || provider === 'gitlab'
              ? 'Create an issue in the selected repository.'
              : 'Create an issue in the selected Linear team.'}
          </Text>
        </View>

        <View style={styles.createForm}>
          <Text style={styles.fieldLabel}>
            {provider === 'github' || provider === 'gitlab' ? 'Repository' : 'Team'}
          </Text>
          <Pressable
            style={styles.targetButton}
            disabled={!taskUiReady}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              setShowCreateTargetPicker(true)
            }}
          >
            {provider === 'github' || provider === 'gitlab' ? (
              <View
                style={[
                  styles.pickerRepoDot,
                  selectedCreateTarget
                    ? {
                        backgroundColor: getRepoBadgeColor(
                          selectedCreateTarget as RepoSummary,
                          (selectedCreateTarget as RepoSummary).displayName
                        )
                      }
                    : undefined
                ]}
              />
            ) : null}
            <Text style={styles.targetButtonText} numberOfLines={1}>
              {selectedCreateTargetLabel}
            </Text>
            <ChevronDown size={14} color={colors.textMuted} />
          </Pressable>

          {provider === 'github' &&
          selectedCreateRepo &&
          hasGitHubIssueSourceChoice(selectedCreateGitHubSources) ? (
            <View style={styles.issueSourceBox}>
              <Text style={styles.fieldLabel}>Issue source</Text>
              <Text style={styles.issueSourceHint} numberOfLines={2}>
                File in{' '}
                {selectedCreateIssuePreference === 'origin'
                  ? issueSourceSlug(selectedCreateGitHubSources?.prs)
                  : issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)}
              </Text>
              <View style={styles.issueSourceSegment}>
                {(['upstream', 'origin'] as const).map((preference) => {
                  const selected = selectedCreateIssuePreference === preference
                  const slug =
                    preference === 'upstream'
                      ? issueSourceSlug(selectedCreateGitHubSources?.upstreamCandidate)
                      : issueSourceSlug(selectedCreateGitHubSources?.prs)
                  return (
                    <Pressable
                      key={preference}
                      style={[
                        styles.issueSourceSegmentButton,
                        selected && styles.issueSourceSegmentButtonActive
                      ]}
                      accessibilityState={{ selected }}
                      onPress={() =>
                        void setGitHubIssueSourcePreference(selectedCreateRepo, preference)
                      }
                    >
                      <Text
                        style={[
                          styles.issueSourceSegmentText,
                          selected && styles.issueSourceSegmentTextActive
                        ]}
                      >
                        {preference === 'upstream' ? 'Upstream' : 'Origin'}
                      </Text>
                      <Text style={styles.issueSourceSlug} numberOfLines={1}>
                        {slug}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={styles.input}
            value={createTitle}
            onChangeText={setCreateTitle}
            placeholder="Task title"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="sentences"
            returnKeyType="next"
          />

          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput
            style={[styles.input, styles.bodyInput]}
            value={createBody}
            onChangeText={setCreateBody}
            placeholder="Add context"
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
          />

          <Pressable
            style={[
              styles.createButton,
              (!taskUiReady || !createTitle.trim() || creatingTask) && styles.createButtonDisabled
            ]}
            disabled={!taskUiReady || !createTitle.trim() || creatingTask}
            onPress={() => void createTask()}
          >
            {creatingTask ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={styles.createButtonText}>Create Issue</Text>
            )}
          </Pressable>
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && showCreateTask && showCreateTargetPicker}
        title={provider === 'linear' ? 'Linear Team' : 'Repository'}
        options={createTargetOptions}
        selected={
          provider === 'github' || provider === 'gitlab'
            ? ((selectedCreateTarget as RepoSummary | null)?.id ?? '')
            : ((selectedCreateTarget as LinearTeam | null)?.id ?? '')
        }
        onSelect={(value) => {
          if (provider === 'github' || provider === 'gitlab') {
            setCreateRepoId(value)
          } else {
            setCreateTeamId(value)
          }
        }}
        onClose={() => setShowCreateTargetPicker(false)}
      />

      <BottomDrawer
        visible={taskUiReady && showLinearConnect}
        onClose={() => {
          if (linearConnectState !== 'connecting') {
            setShowLinearConnect(false)
          }
        }}
      >
        <View style={styles.sheetHeader}>
          <View style={styles.sheetTitleRow}>
            <TaskProviderLogo provider="linear" size={16} color={colors.textPrimary} />
            <Text style={styles.sheetTitle}>Connect Linear workspace</Text>
          </View>
          <Text style={styles.sheetSubtitle}>
            Paste a Personal API key to browse issues from that workspace.
          </Text>
        </View>
        <View style={styles.createForm}>
          <Text style={styles.fieldLabel}>Personal API key</Text>
          <TextInput
            style={styles.input}
            value={linearApiKeyDraft}
            onChangeText={(next) => {
              setLinearApiKeyDraft(next)
              if (linearConnectState === 'error') {
                setLinearConnectState('idle')
                setLinearConnectError('')
              }
            }}
            placeholder="lin_api_..."
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={linearConnectState !== 'connecting'}
            onSubmitEditing={() => void connectLinearAccount()}
          />
          {linearConnectState === 'error' && linearConnectError ? (
            <Text style={styles.detailError}>{linearConnectError}</Text>
          ) : null}
          <Pressable
            style={styles.inlineTextLink}
            onPress={() => void Linking.openURL('https://linear.app/settings/account/security')}
          >
            <ExternalLink size={13} color={colors.textSecondary} />
            <Text style={styles.inlineTextLinkText}>Linear Settings / Security / New API key</Text>
          </Pressable>
          <View style={styles.securityHintRow}>
            <Lock size={13} color={colors.textMuted} />
            <Text style={styles.securityHintText}>
              Your key is encrypted via the host OS keychain and stored locally.
            </Text>
          </View>
          <Pressable
            style={[
              styles.createButton,
              (!linearApiKeyDraft.trim() || linearConnectState === 'connecting') &&
                styles.createButtonDisabled
            ]}
            disabled={!linearApiKeyDraft.trim() || linearConnectState === 'connecting'}
            onPress={() => void connectLinearAccount()}
          >
            {linearConnectState === 'connecting' ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={styles.createButtonText}>Connect</Text>
            )}
          </Pressable>
        </View>
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && workspaceRepoPickerItem != null}
        title="Create Workspace In"
        options={workspaceRepoOptions}
        selected={workspaceRepos[0]?.id ?? ''}
        onSelect={(repoId) => {
          if (workspaceRepoPickerItem) {
            openWorkspaceCreate(workspaceRepoPickerItem, repoId)
          }
          setWorkspaceRepoPickerItem(null)
        }}
        onClose={() => setWorkspaceRepoPickerItem(null)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
      />

      <BottomDrawer
        visible={taskUiReady && workspaceCreateDraft != null}
        onClose={() => setWorkspaceCreateDraft(null)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
      >
        {workspaceCreateDraft ? (
          <View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Create Workspace</Text>
              <Text style={styles.sheetSubtitle} numberOfLines={2}>
                {workspaceCreateDraft.item.title}
              </Text>
            </View>

            <View style={styles.workspaceCreateForm}>
              <View style={styles.workspaceCreateField}>
                <Text style={styles.workspaceCreateLabel}>Repository</Text>
                <Pressable
                  style={styles.fieldButton}
                  disabled={!workspaceCreateCanPickRepo}
                  onPress={() => setShowWorkspaceCreateRepoPicker(true)}
                >
                  {workspaceCreateTargetRepo ? (
                    <View
                      style={[
                        styles.pickerRepoDot,
                        {
                          backgroundColor: getRepoBadgeColor(
                            workspaceCreateTargetRepo,
                            workspaceCreateTargetRepo.displayName
                          )
                        }
                      ]}
                    />
                  ) : null}
                  <Text
                    style={[
                      styles.fieldButtonText,
                      !workspaceCreateTargetRepo ? styles.fieldButtonPlaceholder : undefined
                    ]}
                    numberOfLines={1}
                  >
                    {workspaceCreateTargetRepo?.displayName ?? 'Select a repository'}
                  </Text>
                  {workspaceCreateCanPickRepo ? (
                    <ChevronDown size={14} color={colors.textMuted} />
                  ) : null}
                </Pressable>
              </View>

              {workspaceCreateTargetConnectionId ? (
                <View style={styles.workspaceCreateField}>
                  <Text style={styles.workspaceCreateLabel}>SSH Connection</Text>
                  <View style={styles.sshConnectCard}>
                    <View style={styles.sshStatusRow}>
                      <View
                        style={[
                          styles.sshStatusDot,
                          workspaceCreateSshStatus === 'connected'
                            ? styles.sshStatusDotConnected
                            : workspaceCreateSshConnectInProgress
                              ? styles.sshStatusDotProgress
                              : styles.sshStatusDotDisconnected
                        ]}
                      />
                      <View style={styles.sshStatusCopy}>
                        <Text style={styles.sshStatusTitle} numberOfLines={1}>
                          {workspaceCreateTargetRepo?.displayName ?? 'Remote repository'}
                        </Text>
                        <Text style={styles.detailMuted}>
                          {workspaceSshStatusLabel(workspaceCreateSshStatus)}
                        </Text>
                      </View>
                      {workspaceCreateSshStatus === 'connected' ? null : (
                        <Pressable
                          style={[
                            styles.inlineSaveButtonCompact,
                            workspaceCreateSshConnectInProgress
                              ? styles.fieldButtonDisabled
                              : undefined
                          ]}
                          disabled={workspaceCreateSshConnectInProgress}
                          onPress={() => void connectWorkspaceSshRepo()}
                        >
                          <Text style={styles.inlineSaveText}>
                            {workspaceCreateSshConnectInProgress ? 'Connecting...' : 'Connect'}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                    {workspaceCreateSshError ? (
                      <Text style={styles.detailError}>{workspaceCreateSshError}</Text>
                    ) : null}
                  </View>
                </View>
              ) : null}

              <View style={styles.workspaceCreateField}>
                <Text style={styles.workspaceCreateLabel}>
                  Workspace Name <Text style={styles.workspaceCreateLabelHint}>[Optional]</Text>
                </Text>
                <MobileWorkspaceNameInput
                  style={styles.input}
                  value={workspaceNameDraft}
                  onChangeText={handleWorkspaceNameDraftChange}
                  placeholderTextColor={colors.textMuted}
                  shouldAutoFocus={taskUiReady && workspaceCreateDraft !== null}
                />
              </View>

              <View style={styles.workspaceCreateField}>
                <Text style={styles.workspaceCreateLabel}>Agent</Text>
                <Pressable
                  style={[
                    styles.fieldButton,
                    workspaceCreateRequiresSshConnection ? styles.fieldButtonDisabled : undefined
                  ]}
                  disabled={workspaceCreateRequiresSshConnection}
                  onPress={() => setShowWorkspaceAgentPicker(true)}
                >
                  <MobileAgentIcon
                    agentId={workspaceAgentIconId(resolvedWorkspaceAgent)}
                    size={16}
                  />
                  <Text style={styles.fieldButtonText} numberOfLines={1}>
                    {workspaceCreateRequiresSshConnection
                      ? 'Connect repository first'
                      : workspaceAgentDetectionPending
                        ? 'Detecting agents...'
                        : workspaceAgentLabel(resolvedWorkspaceAgent)}
                  </Text>
                  <ChevronDown size={14} color={colors.textMuted} />
                </Pressable>
              </View>

              <Pressable
                style={styles.workspaceAdvancedToggle}
                onPress={() => setShowWorkspaceAdvanced((current) => !current)}
              >
                <Text style={styles.workspaceAdvancedText}>Advanced</Text>
                {showWorkspaceAdvanced ? (
                  <ChevronUp size={14} color={colors.textSecondary} />
                ) : (
                  <ChevronDown size={14} color={colors.textSecondary} />
                )}
              </Pressable>

              {showWorkspaceAdvanced ? (
                <View style={styles.workspaceCreateField}>
                  <Text style={styles.workspaceCreateLabel}>Start from</Text>
                  <Pressable
                    style={styles.fieldButton}
                    onPress={() => {
                      setWorkspaceBaseBranchQuery(workspaceBaseBranch?.refName ?? '')
                      setShowWorkspaceBaseBranchPicker(true)
                    }}
                  >
                    <GitBranch size={14} color={colors.textMuted} />
                    <Text style={styles.fieldButtonText} numberOfLines={1}>
                      {workspaceBaseBranch?.refName ?? 'Default branch'}
                    </Text>
                    <ChevronDown size={14} color={colors.textMuted} />
                  </Pressable>
                  {workspaceBaseBranch ? (
                    <Text style={styles.detailMuted} numberOfLines={1}>
                      Create from {workspaceBaseBranch.refName}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>

            {workspaceCreateTargetRepo ? null : (
              <Text style={styles.detailError}>
                {workspaceCreateDraft.item.provider === 'linear'
                  ? 'Add a Git repository before creating a Linear workspace.'
                  : 'Repository not found.'}
              </Text>
            )}

            <View style={styles.workspaceCreateActions}>
              <Pressable
                style={[
                  styles.createButton,
                  styles.workspaceCreateButton,
                  (!workspaceCreateTargetRepo ||
                    workspaceCreateRequiresSshConnection ||
                    workspaceAgentDetectionPending ||
                    creatingKey === workspaceCreateDraft.item.key) &&
                    styles.createButtonDisabled
                ]}
                disabled={
                  !workspaceCreateTargetRepo ||
                  workspaceCreateRequiresSshConnection ||
                  workspaceAgentDetectionPending ||
                  creatingKey === workspaceCreateDraft.item.key
                }
                onPress={() => {
                  // Why: this compact issue-to-workspace flow should match the
                  // basic create workspace path; sparse checkout can return later.
                  void createWorkspace(
                    workspaceCreateDraft.item,
                    workspaceCreateDraft.repoIdOverride,
                    undefined,
                    resolvedWorkspaceAgent,
                    workspaceNameDraft.trim(),
                    undefined,
                    workspaceBaseBranch?.refName,
                    workspaceBranchNameOverride &&
                      workspaceNameDraft.trim() === workspaceBranchAutoName
                      ? workspaceBranchNameOverride
                      : undefined,
                    undefined
                  )
                }}
              >
                {creatingKey === workspaceCreateDraft.item.key ? (
                  <ActivityIndicator size="small" color={colors.bgBase} />
                ) : (
                  <Text style={styles.createButtonText}>
                    {workspaceAgentDetectionPending
                      ? 'Detecting agents...'
                      : workspaceCreateRequiresSshConnection
                        ? 'Connect Repository'
                        : 'Create Workspace'}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <PickerModal
        visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceCreateRepoPicker}
        title="Repository"
        options={workspaceRepoOptions}
        selected={workspaceCreateTargetRepo?.id ?? ''}
        onSelect={(repoId) => {
          setWorkspaceCreateDraft((current) =>
            current ? { ...current, repoIdOverride: repoId } : current
          )
          setShowWorkspaceCreateRepoPicker(false)
        }}
        onClose={() => setShowWorkspaceCreateRepoPicker(false)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      />

      <PickerModal
        visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceAgentPicker}
        title="Agent"
        options={workspaceAgentOptions}
        selected={resolvedWorkspaceAgent}
        onSelect={(agent) => {
          setWorkspaceAgentOverridden(true)
          setWorkspaceAgent(agent)
          setShowWorkspaceAgentPicker(false)
        }}
        onClose={() => setShowWorkspaceAgentPicker(false)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      />

      <BottomDrawer
        visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceBaseBranchPicker}
        onClose={() => setShowWorkspaceBaseBranchPicker(false)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      >
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Start From</Text>
            <Text style={styles.sheetSubtitle}>Pick an existing branch or ref.</Text>
          </View>
          <View style={styles.detailGroup}>
            <TextInput
              style={styles.input}
              value={workspaceBaseBranchQuery}
              onChangeText={setWorkspaceBaseBranchQuery}
              placeholder="Search branches"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={styles.pickerRow}
              onPress={() => {
                clearWorkspaceBaseBranch()
              }}
            >
              <View style={styles.pickerCheck}>
                {workspaceBaseBranch === null ? (
                  <Check size={16} color={colors.textPrimary} />
                ) : null}
              </View>
              <View style={styles.pickerContent}>
                <Text style={styles.pickerLabel}>Default branch</Text>
                <Text style={styles.pickerSubtitle}>Use this repository's configured base</Text>
              </View>
            </Pressable>
            {workspaceBaseBranchLoading ? (
              <View style={styles.drawerLoadingRow}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
              </View>
            ) : workspaceBaseBranchError ? (
              <Text style={styles.detailError}>{workspaceBaseBranchError}</Text>
            ) : workspaceBaseBranchQuery.trim() && workspaceBaseBranchResults.length === 0 ? (
              <Text style={styles.detailMuted}>No branches match.</Text>
            ) : null}
            {workspaceBaseBranchResults.map((branch) => (
              <View key={`${branch.refName}:${branch.localBranchName}`}>
                <View style={styles.groupSeparator} />
                <Pressable
                  style={styles.pickerRow}
                  onPress={() => {
                    selectWorkspaceBaseBranch(branch)
                  }}
                >
                  <View style={styles.pickerCheck}>
                    {workspaceBaseBranch?.refName === branch.refName ? (
                      <Check size={16} color={colors.textPrimary} />
                    ) : null}
                  </View>
                  <View style={styles.pickerContent}>
                    <Text style={[styles.pickerLabel, styles.monoText]} numberOfLines={1}>
                      {branch.refName}
                    </Text>
                    {branch.localBranchName !== branch.refName ? (
                      <Text style={styles.pickerSubtitle} numberOfLines={1}>
                        Branch name: {branch.localBranchName}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && workspaceCreateDraft != null && showWorkspaceSparsePicker}
        onClose={() => setShowWorkspaceSparsePicker(false)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      >
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Sparse Checkout</Text>
          </View>
          <View style={styles.detailGroup}>
            <Pressable
              style={styles.pickerRow}
              onPress={() => {
                setWorkspaceSparsePresetId(null)
                setShowWorkspaceSparsePicker(false)
              }}
            >
              <View style={styles.pickerCheck}>
                {workspaceSparsePresetId === null ? (
                  <Check size={16} color={colors.textPrimary} />
                ) : null}
              </View>
              <View style={styles.pickerContent}>
                <Text style={styles.pickerLabel}>Full checkout</Text>
                <Text style={styles.pickerSubtitle}>Use the whole repository</Text>
              </View>
            </Pressable>
            {workspaceSparsePresets.map((preset) => (
              <View key={preset.id}>
                <View style={styles.groupSeparator} />
                <View style={styles.pickerRowWithAction}>
                  <Pressable
                    style={styles.pickerRowMain}
                    onPress={() => {
                      setWorkspaceSparsePresetId(preset.id)
                      setShowWorkspaceSparsePicker(false)
                    }}
                  >
                    <View style={styles.pickerCheck}>
                      {workspaceSparsePresetId === preset.id ? (
                        <Check size={16} color={colors.textPrimary} />
                      ) : null}
                    </View>
                    <View style={styles.pickerContent}>
                      <Text style={styles.pickerLabel} numberOfLines={1}>
                        {preset.name}
                      </Text>
                      <Text style={styles.pickerSubtitle} numberOfLines={2}>
                        {preset.directories.join(', ')}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    style={styles.iconActionButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${preset.name}`}
                    onPress={() => startEditWorkspaceSparsePreset(preset)}
                  >
                    <Pencil size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
          <Pressable
            style={[
              styles.inlineSaveButton,
              !workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading
                ? styles.fieldButtonDisabled
                : undefined
            ]}
            disabled={!workspaceSparsePresetsLoaded || workspaceSparsePresetsLoading}
            onPress={startNewWorkspaceSparsePreset}
          >
            <Text style={styles.inlineSaveText}>New preset</Text>
          </Pressable>
        </View>
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && workspaceCreateDraft != null && workspaceSparseDraft != null}
        onClose={() => {
          if (!workspaceSparseSaving) {
            setWorkspaceSparseDraft(null)
          }
        }}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 2}
      >
        {workspaceSparseDraft ? (
          <View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {workspaceSparseDraft.mode === 'new' ? 'New Sparse Preset' : 'Edit Sparse Preset'}
              </Text>
            </View>
            <View style={styles.detailGroup}>
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Name</Text>
                <TextInput
                  style={styles.input}
                  value={workspaceSparseDraft.name}
                  onChangeText={(name) =>
                    setWorkspaceSparseDraft({ ...workspaceSparseDraft, name })
                  }
                  placeholder="Renderer UI"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={80}
                />
              </View>
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Directories</Text>
                <TextInput
                  style={[styles.input, styles.bodyInput, styles.monoInput]}
                  value={workspaceSparseDraft.directoriesText}
                  onChangeText={(directoriesText) =>
                    setWorkspaceSparseDraft({ ...workspaceSparseDraft, directoriesText })
                  }
                  placeholder={'src/renderer\npackages/ui'}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  textAlignVertical="top"
                />
              </View>
              <Text style={workspaceSparseDraftError ? styles.detailError : styles.detailMuted}>
                {workspaceSparseDraftError ??
                  (workspaceSparseDraftParsed?.directories.length === 1
                    ? '1 directory'
                    : `${workspaceSparseDraftParsed?.directories.length ?? 0} directories`)}
              </Text>
            </View>
            <View style={styles.drawerActionRow}>
              <Pressable
                style={styles.secondaryActionButton}
                disabled={workspaceSparseSaving}
                onPress={() => setWorkspaceSparseDraft(null)}
              >
                <Text style={styles.secondaryActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.primaryActionButton,
                  !canSaveWorkspaceSparseDraft ? styles.fieldButtonDisabled : undefined
                ]}
                disabled={!canSaveWorkspaceSparseDraft}
                onPress={() => void saveWorkspaceSparsePreset()}
              >
                {workspaceSparseSaving ? (
                  <ActivityIndicator size="small" color={colors.bgBase} />
                ) : null}
                <Text style={styles.primaryActionText}>Save</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && setupPrompt != null}
        onClose={() => setSetupPrompt(null)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      >
        {setupPrompt ? (
          <View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Run Setup Script?</Text>
              <Text style={styles.sheetSubtitle}>
                {setupPrompt.repoName} requires a setup choice before creating this workspace.
              </Text>
            </View>

            <View style={styles.setupPromptBox}>
              <View style={styles.detailSectionHeader}>
                <Text style={styles.detailSectionTitle}>
                  {setupSourceLabel(setupPrompt.source)}
                </Text>
              </View>
              <Text style={styles.setupPromptCommand}>{setupPrompt.command}</Text>
            </View>

            <View style={styles.actionGroup}>
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === setupPrompt.item.key}
                onPress={() =>
                  void createWorkspace(
                    setupPrompt.item,
                    setupPrompt.repoIdOverride,
                    'run',
                    setupPrompt.agentOverride,
                    setupPrompt.workspaceNameOverride,
                    setupPrompt.noteOverride,
                    setupPrompt.baseBranchOverride,
                    setupPrompt.branchNameOverride,
                    setupPrompt.sparseCheckoutOverride
                  )
                }
              >
                <Check size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>
                  {creatingKey === setupPrompt.item.key ? 'Creating...' : 'Run setup and create'}
                </Text>
              </Pressable>
              <View style={styles.actionSeparator} />
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === setupPrompt.item.key}
                onPress={() =>
                  void createWorkspace(
                    setupPrompt.item,
                    setupPrompt.repoIdOverride,
                    'skip',
                    setupPrompt.agentOverride,
                    setupPrompt.workspaceNameOverride,
                    setupPrompt.noteOverride,
                    setupPrompt.baseBranchOverride,
                    setupPrompt.branchNameOverride,
                    setupPrompt.sparseCheckoutOverride
                  )
                }
              >
                <X size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Skip setup and create</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && orcaYamlTrustPrompt != null}
        onClose={() => setOrcaYamlTrustPrompt(null)}
        zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      >
        {orcaYamlTrustPrompt ? (
          <View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {orcaYamlTrustPrompt.previouslyApproved
                  ? `${orcaYamlTrustPrompt.repoName}'s setup script changed`
                  : `Run setup from ${orcaYamlTrustPrompt.repoName}?`}
              </Text>
              <Text style={styles.sheetSubtitle}>
                This repository's orca.yaml runs on your machine before the workspace starts. Only
                run it if you trust this repository.
              </Text>
            </View>

            <View style={styles.setupPromptBox}>
              <View style={styles.detailSectionHeader}>
                <Text style={styles.detailSectionTitle}>
                  {orcaYamlTrustPrompt.previouslyApproved ? 'New setup script' : 'Setup script'}
                </Text>
              </View>
              <Text style={styles.setupPromptCommand}>{orcaYamlTrustPrompt.scriptContent}</Text>
            </View>

            <View style={styles.actionGroup}>
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === orcaYamlTrustPrompt.item.key}
                onPress={() =>
                  void (async () => {
                    try {
                      await persistSetupHookTrust(
                        orcaYamlTrustPrompt.repoId,
                        orcaYamlTrustPrompt.contentHash,
                        false
                      )
                      setOrcaYamlTrustPrompt(null)
                      await createWorkspace(
                        orcaYamlTrustPrompt.item,
                        orcaYamlTrustPrompt.repoIdOverride,
                        'run',
                        orcaYamlTrustPrompt.agentOverride,
                        orcaYamlTrustPrompt.workspaceNameOverride,
                        orcaYamlTrustPrompt.noteOverride,
                        orcaYamlTrustPrompt.baseBranchOverride,
                        orcaYamlTrustPrompt.branchNameOverride,
                        orcaYamlTrustPrompt.sparseCheckoutOverride,
                        orcaYamlTrustPrompt.contentHash
                      )
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                    }
                  })()
                }
              >
                <Check size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Run hooks</Text>
              </Pressable>
              <View style={styles.actionSeparator} />
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === orcaYamlTrustPrompt.item.key}
                onPress={() =>
                  void (async () => {
                    try {
                      await persistSetupHookTrust(
                        orcaYamlTrustPrompt.repoId,
                        orcaYamlTrustPrompt.contentHash,
                        true
                      )
                      setOrcaYamlTrustPrompt(null)
                      await createWorkspace(
                        orcaYamlTrustPrompt.item,
                        orcaYamlTrustPrompt.repoIdOverride,
                        'run',
                        orcaYamlTrustPrompt.agentOverride,
                        orcaYamlTrustPrompt.workspaceNameOverride,
                        orcaYamlTrustPrompt.noteOverride,
                        orcaYamlTrustPrompt.baseBranchOverride,
                        orcaYamlTrustPrompt.branchNameOverride,
                        orcaYamlTrustPrompt.sparseCheckoutOverride,
                        orcaYamlTrustPrompt.contentHash
                      )
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                    }
                  })()
                }
              >
                <Check size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Always trust and run</Text>
              </Pressable>
              <View style={styles.actionSeparator} />
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === orcaYamlTrustPrompt.item.key}
                onPress={() => {
                  const prompt = orcaYamlTrustPrompt
                  setOrcaYamlTrustPrompt(null)
                  void createWorkspace(
                    prompt.item,
                    prompt.repoIdOverride,
                    'skip',
                    prompt.agentOverride,
                    prompt.workspaceNameOverride,
                    prompt.noteOverride,
                    prompt.baseBranchOverride,
                    prompt.branchNameOverride,
                    prompt.sparseCheckoutOverride
                  )
                }}
              >
                <X size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Don't run</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && projectRepoNotInOrca != null}
        onClose={() => {
          setProjectRepoNotInOrca(null)
        }}
      >
        {projectRepoNotInOrca ? (
          <View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Repository not in Orca</Text>
              <Text style={styles.sheetSubtitle}>
                {projectRepoNotInOrca.owner}/{projectRepoNotInOrca.repo} is not added to Orca. Add
                this repository from the desktop app, then refresh mobile Tasks.
              </Text>
            </View>

            <View style={styles.actionGroup}>
              {projectRepoNotInOrca.url ? (
                <Pressable
                  style={styles.actionRow}
                  onPress={() => {
                    if (projectRepoNotInOrca.url) {
                      void Linking.openURL(projectRepoNotInOrca.url)
                    }
                  }}
                >
                  <ExternalLink size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Open in GitHub</Text>
                </Pressable>
              ) : null}
              {projectRepoNotInOrca.url ? <View style={styles.actionSeparator} /> : null}
              <Pressable
                style={styles.actionRow}
                onPress={() =>
                  void copyTextToClipboard(
                    `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`,
                    `${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                  )
                }
              >
                <Copy size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>
                  {copiedLinkKey ===
                  `project-repo:${projectRepoNotInOrca.owner}/${projectRepoNotInOrca.repo}`
                    ? 'Copied'
                    : 'Copy repository'}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <BottomDrawer
        visible={taskUiReady && projectRowItem != null}
        onClose={() => setProjectRowItem(null)}
      >
        {projectRowItem ? (
          <View>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleRow}>
                <TaskProviderLogo provider="github" size={16} color={colors.textPrimary} />
                <Text style={styles.sheetTitle} numberOfLines={2}>
                  {projectRowItem.content.title}
                </Text>
              </View>
              <Text style={styles.sheetSubtitle}>
                GitHub Project · {projectRowItem.content.repository ?? activeProjectLabel}
                {projectRowItem.content.number ? ` #${projectRowItem.content.number}` : ''}
              </Text>
            </View>

            <View style={styles.detailGroup}>
              <View style={styles.detailMetaGrid}>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Type</Text>
                  <Text style={styles.detailMetaValue}>
                    {projectRowItem.itemType === 'PULL_REQUEST'
                      ? 'Pull request'
                      : projectRowItem.itemType === 'ISSUE'
                        ? 'Issue'
                        : projectRowItem.itemType === 'DRAFT_ISSUE'
                          ? 'Draft issue'
                          : 'Project item'}
                  </Text>
                </View>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Status</Text>
                  <Text style={styles.detailMetaValue}>
                    {projectRowStatusLabel(projectRowItem)}
                  </Text>
                </View>
              </View>
              {SHOW_MOBILE_DETAIL_LABEL_CHIPS &&
              (projectRowDetail?.provider === 'github'
                ? projectRowDetail.labels
                : projectRowItem.content.labels.map((label) => label.name)
              ).length > 0 ? (
                <View style={styles.chipRow}>
                  {(projectRowDetail?.provider === 'github'
                    ? projectRowDetail.labels
                    : projectRowItem.content.labels.map((label) => label.name)
                  )
                    .slice(0, 6)
                    .map((label) => (
                      <View key={label} style={styles.detailChip}>
                        <Text style={styles.detailChipText}>{label}</Text>
                      </View>
                    ))}
                </View>
              ) : null}
              {SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowItem.itemType === 'ISSUE' ? (
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Text style={styles.detailSectionTitle}>Issue type</Text>
                    <Text style={styles.detailSectionMeta}>
                      {projectRowItem.content.issueType?.name ?? 'No type'}
                    </Text>
                  </View>
                  {projectIssueTypesLoading ? (
                    <View style={styles.detailLoadingInline}>
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                      <Text style={styles.detailMuted}>Loading issue types...</Text>
                    </View>
                  ) : projectIssueTypesError ? (
                    <Text style={styles.detailError}>{projectIssueTypesError}</Text>
                  ) : projectIssueTypes.length === 0 ? (
                    <Text style={styles.detailMuted}>
                      No issue types configured for this repository.
                    </Text>
                  ) : (
                    <View style={styles.chipRow}>
                      {projectIssueTypes.map((issueType) => {
                        const selected = projectRowItem.content.issueType?.id === issueType.id
                        return (
                          <Pressable
                            key={issueType.id}
                            style={[
                              styles.detailChip,
                              selected ? styles.detailChipSelected : undefined
                            ]}
                            disabled={projectMutating || selected}
                            onPress={() =>
                              void mutateProjectRowIssueType(projectRowItem, issueType)
                            }
                          >
                            <View style={styles.issueTypeChipContent}>
                              <View
                                style={[
                                  styles.issueTypeDot,
                                  { backgroundColor: githubProjectOptionColor(issueType.color) }
                                ]}
                              />
                              <Text style={styles.detailChipText}>{issueType.name}</Text>
                            </View>
                          </Pressable>
                        )
                      })}
                      {projectRowItem.content.issueType ? (
                        <Pressable
                          style={styles.detailChip}
                          disabled={projectMutating}
                          onPress={() => void mutateProjectRowIssueType(projectRowItem, null)}
                        >
                          <Text style={styles.detailChipText}>Clear type</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                </View>
              ) : null}
              {SHOW_MOBILE_PROJECT_METADATA_EDITORS &&
              editableProjectFields(githubProjectTable).length > 0 ? (
                <View style={styles.detailSection}>
                  <Text style={styles.detailSectionTitle}>Project fields</Text>
                  {editableProjectFields(githubProjectTable).map((field) => {
                    const currentLabel = projectFieldValueLabel(projectRowItem, field)
                    const draftValue = projectFieldDrafts[field.id] ?? ''
                    const saveTextField = (): void => {
                      if (field.dataType === 'NUMBER') {
                        const number = Number(draftValue)
                        if (!Number.isFinite(number)) {
                          setProjectRowDetailError('Enter a valid number.')
                          return
                        }
                        void mutateProjectRowField(projectRowItem, field, {
                          kind: 'number',
                          number
                        })
                        return
                      }
                      if (field.dataType === 'DATE') {
                        const date = draftValue.trim()
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                          setProjectRowDetailError('Enter a date as YYYY-MM-DD.')
                          return
                        }
                        void mutateProjectRowField(projectRowItem, field, { kind: 'date', date })
                        return
                      }
                      void mutateProjectRowField(projectRowItem, field, {
                        kind: 'text',
                        text: draftValue
                      })
                    }
                    return (
                      <View key={field.id} style={styles.projectFieldCard}>
                        <View style={styles.detailSectionHeader}>
                          <Text style={styles.projectFieldName}>{field.name}</Text>
                          <Text style={styles.projectFieldValue} numberOfLines={1}>
                            {currentLabel}
                          </Text>
                        </View>
                        {field.dataType === 'SINGLE_SELECT' && field.kind === 'single-select' ? (
                          <View style={styles.chipRow}>
                            {field.options.map((option) => {
                              const fieldValue = projectRowItem.fieldValuesByFieldId?.[field.id]
                              const selected =
                                fieldValue?.kind === 'single-select' &&
                                fieldValue.optionId === option.id
                              return (
                                <Pressable
                                  key={option.id}
                                  style={[
                                    styles.detailChip,
                                    selected ? styles.detailChipSelected : undefined
                                  ]}
                                  disabled={projectMutating}
                                  accessibilityState={{ selected }}
                                  onPress={() =>
                                    void mutateProjectRowField(projectRowItem, field, {
                                      kind: 'single-select',
                                      optionId: option.id
                                    })
                                  }
                                >
                                  <View style={styles.issueTypeChipContent}>
                                    {selected ? (
                                      <Check size={12} color={colors.accentBlue} />
                                    ) : null}
                                    <Text style={styles.detailChipText}>{option.name}</Text>
                                  </View>
                                </Pressable>
                              )
                            })}
                          </View>
                        ) : field.dataType === 'ITERATION' && field.kind === 'iteration' ? (
                          <View style={styles.projectIterationList}>
                            {field.iterations.length === 0 ? (
                              <Text style={styles.detailMuted}>No iterations available.</Text>
                            ) : (
                              field.iterations.map((iteration) => {
                                const fieldValue = projectRowItem.fieldValuesByFieldId?.[field.id]
                                const selected =
                                  fieldValue?.kind === 'iteration' &&
                                  fieldValue.iterationId === iteration.id
                                return (
                                  <Pressable
                                    key={iteration.id}
                                    style={styles.actionRow}
                                    disabled={projectMutating}
                                    accessibilityState={{ selected }}
                                    onPress={() =>
                                      void mutateProjectRowField(projectRowItem, field, {
                                        kind: 'iteration',
                                        iterationId: iteration.id
                                      })
                                    }
                                  >
                                    <View style={styles.projectIterationCopy}>
                                      <Text style={styles.actionText}>{iteration.title}</Text>
                                      <Text style={styles.detailMuted}>
                                        {iteration.completed ? 'Completed' : 'Current & upcoming'} ·{' '}
                                        {iteration.startDate} · {iteration.duration}d
                                      </Text>
                                    </View>
                                    {selected ? (
                                      <Check size={14} color={colors.textSecondary} />
                                    ) : null}
                                  </Pressable>
                                )
                              })
                            )}
                          </View>
                        ) : (
                          <>
                            <TextInput
                              style={styles.input}
                              value={draftValue}
                              onChangeText={(next) =>
                                setProjectFieldDrafts((current) => ({
                                  ...current,
                                  [field.id]: next
                                }))
                              }
                              placeholder={
                                field.dataType === 'DATE'
                                  ? 'YYYY-MM-DD'
                                  : field.dataType === 'NUMBER'
                                    ? 'Number'
                                    : 'Text'
                              }
                              placeholderTextColor={colors.textMuted}
                              keyboardType={field.dataType === 'NUMBER' ? 'numeric' : 'default'}
                              autoCapitalize="none"
                            />
                            <Pressable
                              style={styles.inlineSaveButton}
                              disabled={projectMutating}
                              onPress={saveTextField}
                            >
                              <Text style={styles.inlineSaveText}>Save field</Text>
                            </Pressable>
                          </>
                        )}
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={projectMutating || currentLabel === 'Empty'}
                          onPress={() => void mutateProjectRowField(projectRowItem, field, null)}
                        >
                          <Text style={styles.inlineSaveText}>Clear field</Text>
                        </Pressable>
                      </View>
                    )
                  })}
                </View>
              ) : null}
              {SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Text style={styles.detailSectionTitle}>Labels</Text>
                    <Text style={styles.detailSectionMeta}>
                      {(projectRowDetail?.provider === 'github'
                        ? projectRowDetail.labels
                        : projectRowItem.content.labels.map((label) => label.name)
                      ).length || 'None'}
                    </Text>
                  </View>
                  {projectLabelsLoading ? (
                    <View style={styles.detailLoadingInline}>
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                      <Text style={styles.detailMuted}>Loading labels...</Text>
                    </View>
                  ) : projectLabelsError ? (
                    <Text style={styles.detailError}>{projectLabelsError}</Text>
                  ) : projectAvailableLabels.length === 0 ? (
                    <Text style={styles.detailMuted}>No labels in this repository.</Text>
                  ) : (
                    <View style={styles.chipRow}>
                      {[
                        ...new Set([
                          ...projectAvailableLabels,
                          ...(projectRowDetail?.provider === 'github'
                            ? projectRowDetail.labels
                            : projectRowItem.content.labels.map((label) => label.name))
                        ])
                      ].map((label) => {
                        const selected = (
                          projectRowDetail?.provider === 'github'
                            ? projectRowDetail.labels
                            : projectRowItem.content.labels.map((entry) => entry.name)
                        ).includes(label)
                        return (
                          <Pressable
                            key={label}
                            style={[
                              styles.detailChip,
                              selected ? styles.detailChipSelected : undefined
                            ]}
                            disabled={projectMutating}
                            onPress={() =>
                              void mutateProjectRowMetadata(
                                projectRowItem,
                                selected ? { removeLabels: [label] } : { addLabels: [label] }
                              )
                            }
                          >
                            <View style={styles.issueTypeChipContent}>
                              {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                              <Text style={styles.detailChipText}>{label}</Text>
                            </View>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </View>
              ) : null}
              {SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Text style={styles.detailSectionTitle}>Assignees</Text>
                    <Text style={styles.detailSectionMeta}>
                      {(projectRowDetail?.provider === 'github'
                        ? projectRowDetail.assignees
                        : projectRowItem.content.assignees.map((assignee) => assignee.login)
                      ).length || 'None'}
                    </Text>
                  </View>
                  {projectAssignableUsersLoading ? (
                    <View style={styles.detailLoadingInline}>
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                      <Text style={styles.detailMuted}>Loading assignees...</Text>
                    </View>
                  ) : projectAssignableUsersError ? (
                    <Text style={styles.detailError}>{projectAssignableUsersError}</Text>
                  ) : projectAssignableUsers.length === 0 ? (
                    <Text style={styles.detailMuted}>
                      No assignable users found for this repository.
                    </Text>
                  ) : (
                    <View style={styles.chipRow}>
                      {[
                        ...new Map(
                          [
                            ...projectAssignableUsers,
                            ...projectRowItem.content.assignees,
                            ...(projectRowDetail?.provider === 'github'
                              ? projectRowDetail.assignees.map((login) => ({
                                  login,
                                  name: null,
                                  avatarUrl: null
                                }))
                              : [])
                          ].map((user) => [user.login, user])
                        ).values()
                      ].map((user) => {
                        const selected = (
                          projectRowDetail?.provider === 'github'
                            ? projectRowDetail.assignees
                            : projectRowItem.content.assignees.map((assignee) => assignee.login)
                        ).includes(user.login)
                        return (
                          <Pressable
                            key={user.login}
                            style={[
                              styles.detailChip,
                              selected ? styles.detailChipSelected : undefined
                            ]}
                            disabled={projectMutating}
                            onPress={() =>
                              void mutateProjectRowMetadata(
                                projectRowItem,
                                selected
                                  ? { removeAssignees: [user.login] }
                                  : { addAssignees: [user.login] }
                              )
                            }
                          >
                            <View style={styles.issueTypeChipContent}>
                              {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                              <Text style={styles.detailChipText}>{user.login}</Text>
                            </View>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </View>
              ) : null}
              {projectRowDetailLoading ? (
                <View style={styles.detailLoading}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : projectRowDetailError ? (
                <Text style={styles.detailError}>{projectRowDetailError}</Text>
              ) : (
                <>
                  {SHOW_MOBILE_PROJECT_METADATA_EDITORS && projectRowType(projectRowItem) ? (
                    <>
                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Title</Text>
                        <TextInput
                          style={styles.input}
                          value={projectTitleDraft}
                          onChangeText={setProjectTitleDraft}
                          placeholder="Title"
                          placeholderTextColor={colors.textMuted}
                        />
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={
                            projectMutating ||
                            projectTitleDraft.trim() === projectRowItem.content.title
                          }
                          onPress={() =>
                            void mutateProjectRowIssueOrPr(projectRowItem, {
                              title: projectTitleDraft.trim()
                            })
                          }
                        >
                          <Text style={styles.inlineSaveText}>Save title</Text>
                        </Pressable>
                      </View>
                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Description</Text>
                        <TextInput
                          style={[styles.input, styles.bodyInput]}
                          value={projectBodyDraft}
                          onChangeText={setProjectBodyDraft}
                          placeholder="Description"
                          placeholderTextColor={colors.textMuted}
                          multiline
                          textAlignVertical="top"
                        />
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={
                            projectMutating ||
                            projectBodyDraft ===
                              (projectRowDetail?.provider === 'github'
                                ? projectRowDetail.body
                                : (projectRowItem.content.body ?? ''))
                          }
                          onPress={() =>
                            void mutateProjectRowIssueOrPr(projectRowItem, {
                              body: projectBodyDraft
                            })
                          }
                        >
                          <Text style={styles.inlineSaveText}>Save description</Text>
                        </Pressable>
                        <MobileMarkdown content={projectBodyDraft} fallback="No description." />
                      </View>
                    </>
                  ) : (
                    <>
                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Title</Text>
                        <Text style={styles.detailLine}>{projectRowItem.content.title}</Text>
                      </View>
                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Description</Text>
                        <MobileMarkdown content={projectBodyDraft} fallback="No description." />
                      </View>
                    </>
                  )}
                  {SHOW_MOBILE_PROJECT_REVIEW_PANELS &&
                  projectRowItem.itemType === 'PULL_REQUEST' &&
                  projectRowDetail?.provider === 'github' &&
                  projectRowHostedRepo ? (
                    <>
                      <View style={styles.detailSection}>
                        <View style={styles.detailSectionHeader}>
                          <Text style={styles.detailSectionTitle}>Reviewers</Text>
                          <Text style={styles.detailSectionMeta}>
                            {getGitHubReviewSummary(projectRowDetail)}
                          </Text>
                        </View>
                        {getGitHubReviewerRows(projectRowDetail).length === 0 ? (
                          <Text style={styles.detailMuted}>No reviewers requested.</Text>
                        ) : (
                          getGitHubReviewerRows(projectRowDetail).map((reviewer) => (
                            <View key={reviewer.login} style={styles.reviewerRow}>
                              <View style={styles.reviewerAvatar}>
                                <Text style={styles.reviewerAvatarText}>
                                  {reviewer.login.slice(0, 1).toUpperCase()}
                                </Text>
                              </View>
                              <View style={styles.reviewerInfo}>
                                <Text style={styles.reviewerName} numberOfLines={1}>
                                  {reviewer.login}
                                </Text>
                                {reviewer.name ? (
                                  <Text style={styles.reviewerMeta} numberOfLines={1}>
                                    {reviewer.name}
                                  </Text>
                                ) : null}
                              </View>
                              <Text style={styles.reviewerState}>{reviewer.stateLabel}</Text>
                            </View>
                          ))
                        )}
                        {projectAssignableUsersLoading ? (
                          <View style={styles.detailLoadingInline}>
                            <ActivityIndicator size="small" color={colors.textSecondary} />
                            <Text style={styles.detailMuted}>Loading reviewers...</Text>
                          </View>
                        ) : projectAssignableUsersError ? (
                          <Text style={styles.detailError}>{projectAssignableUsersError}</Text>
                        ) : projectReviewerCandidates.length === 0 ? (
                          <Text style={styles.detailMuted}>No reviewer suggestions found.</Text>
                        ) : (
                          <View style={styles.chipRow}>
                            {projectReviewerCandidates.map((user) => {
                              const selected = projectSelectedReviewerLogins.has(
                                user.login.trim().toLowerCase()
                              )
                              return (
                                <Pressable
                                  key={user.login}
                                  style={[
                                    styles.detailChip,
                                    selected ? styles.detailChipSelected : undefined
                                  ]}
                                  disabled={projectMutating || selected}
                                  onPress={() =>
                                    void requestProjectGitHubReviewers(projectRowItem, [user.login])
                                  }
                                >
                                  <View style={styles.issueTypeChipContent}>
                                    {selected ? (
                                      <Check size={12} color={colors.accentBlue} />
                                    ) : null}
                                    <Text style={styles.detailChipText}>{user.login}</Text>
                                  </View>
                                </Pressable>
                              )
                            })}
                          </View>
                        )}
                        <TextInput
                          style={styles.input}
                          value={projectReviewersDraft}
                          onChangeText={setProjectReviewersDraft}
                          placeholder="Request reviewers"
                          placeholderTextColor={colors.textMuted}
                          autoCapitalize="none"
                        />
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={
                            projectMutating || splitReviewerList(projectReviewersDraft).length === 0
                          }
                          onPress={() => void requestProjectGitHubReviewers(projectRowItem)}
                        >
                          <Text style={styles.inlineSaveText}>Request review</Text>
                        </Pressable>
                      </View>

                      {projectRowType(projectRowItem) === 'pr' ? (
                        <View style={styles.detailSection}>
                          <View style={styles.detailSectionHeader}>
                            <Text style={styles.detailSectionTitle}>Checks</Text>
                            <View style={styles.inlineActionRow}>
                              <Pressable
                                style={styles.inlineSaveButtonCompact}
                                disabled={projectMutating}
                                onPress={() => void refreshProjectGitHubChecks(projectRowItem)}
                              >
                                <Text style={styles.inlineSaveText}>Refresh</Text>
                              </Pressable>
                              <Pressable
                                style={styles.inlineSaveButtonCompact}
                                disabled={
                                  projectMutating ||
                                  !projectRowDetail.checks.some(isFailedGitHubCheck)
                                }
                                onPress={() => void rerunProjectGitHubChecks(projectRowItem, true)}
                              >
                                <Text style={styles.inlineSaveText}>Rerun failed</Text>
                              </Pressable>
                              <Pressable
                                style={styles.inlineSaveButtonCompact}
                                disabled={projectMutating || projectRowDetail.checks.length === 0}
                                onPress={() => void rerunProjectGitHubChecks(projectRowItem, false)}
                              >
                                <Text style={styles.inlineSaveText}>Rerun all</Text>
                              </Pressable>
                            </View>
                          </View>
                          {projectRowDetail.checks.length === 0 ? (
                            <Text style={styles.detailMuted}>No checks found.</Text>
                          ) : (
                            projectRowDetail.checks.map((check) => (
                              <Pressable
                                key={`${check.name}:${check.status}:${check.url ?? ''}`}
                                style={styles.fileActionRow}
                                disabled={!check.url}
                                onPress={() => {
                                  if (check.url) {
                                    void Linking.openURL(check.url)
                                  }
                                }}
                              >
                                <Text style={styles.detailLine} numberOfLines={2}>
                                  {check.name} · {check.conclusion ?? check.status}
                                </Text>
                                {check.url ? (
                                  <ExternalLink size={14} color={colors.textSecondary} />
                                ) : null}
                              </Pressable>
                            ))
                          )}
                        </View>
                      ) : null}

                      {projectRowDetail.files.length > 0 ? (
                        <View style={styles.detailSection}>
                          <Text style={styles.detailSectionTitle}>Changed files</Text>
                          {projectRowDetail.files.map((file) => (
                            <View key={file.path} style={styles.fileCard}>
                              <Pressable
                                style={styles.fileActionRow}
                                disabled={projectMutating}
                                onPress={() =>
                                  void toggleProjectGitHubFileExpansion(projectRowItem, file)
                                }
                              >
                                <Text style={styles.detailLine}>
                                  {file.path}
                                  {typeof file.additions === 'number' ||
                                  typeof file.deletions === 'number'
                                    ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
                                    : ''}
                                </Text>
                                <Text style={styles.detailSectionMeta}>
                                  {expandedPrFilePath === file.path ? 'Hide' : 'View'}
                                </Text>
                              </Pressable>
                              <Pressable
                                style={styles.inlineSaveButtonCompact}
                                disabled={projectMutating || !projectRowDetail.pullRequestId}
                                onPress={() =>
                                  void toggleProjectGitHubFileViewed(projectRowItem, file)
                                }
                              >
                                <Text style={styles.inlineSaveText}>
                                  {file.viewerViewedState === 'VIEWED'
                                    ? 'Mark unviewed'
                                    : 'Mark viewed'}
                                </Text>
                              </Pressable>
                              {expandedPrFilePath === file.path ? (
                                <View style={styles.filePreview}>
                                  {prFileLoadingPath === file.path ? (
                                    <ActivityIndicator size="small" color={colors.textSecondary} />
                                  ) : prFileContents[file.path]?.originalIsBinary ||
                                    prFileContents[file.path]?.modifiedIsBinary ? (
                                    <Text style={styles.detailMuted}>Binary file.</Text>
                                  ) : prFileContents[file.path] ? (
                                    <GitHubPrFileDiff
                                      filePath={file.path}
                                      contents={prFileContents[file.path]}
                                      commentDrafts={prFileCommentDrafts}
                                      disabled={projectMutating}
                                      onCommentDraftChange={(draftKey, next) =>
                                        setPrFileCommentDrafts((current) => ({
                                          ...current,
                                          [draftKey]: next
                                        }))
                                      }
                                      onSubmitComment={(line) =>
                                        void addProjectGitHubFileReviewComment(
                                          projectRowItem,
                                          file,
                                          line
                                        )
                                      }
                                    />
                                  ) : (
                                    <Text style={styles.detailMuted}>
                                      File contents unavailable.
                                    </Text>
                                  )}
                                </View>
                              ) : null}
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </>
                  ) : null}
                  {projectRowDetail?.provider === 'github' ? (
                    <View style={styles.detailSection}>
                      <View style={styles.detailSectionHeader}>
                        <Text style={styles.detailSectionTitle}>Discussion</Text>
                        <Text style={styles.detailSectionMeta}>
                          {discussionSummary(projectRowDetail.comments.length)}
                        </Text>
                      </View>
                      {projectRowDetail.comments.length === 0 ? (
                        <Text style={styles.detailMuted}>No comments.</Text>
                      ) : (
                        projectDetailCommentGroups.map((group) => {
                          const groupId = detailCommentGroupId(group)
                          const root = detailCommentGroupRoot(group)
                          const count = detailCommentGroupCount(group)
                          const isCollapsedResolved =
                            isResolvedDetailCommentGroup(group) &&
                            !expandedResolvedCommentGroups.has(groupId)
                          if (isCollapsedResolved) {
                            return (
                              <Pressable
                                key={groupId}
                                style={styles.resolvedCommentSummary}
                                onPress={() =>
                                  setExpandedResolvedCommentGroups((current) => {
                                    const next = new Set(current)
                                    next.add(groupId)
                                    return next
                                  })
                                }
                              >
                                <Text style={styles.resolvedCommentTitle} numberOfLines={1}>
                                  Resolved {group.kind === 'thread' ? 'thread' : 'comment'} by{' '}
                                  {commentAuthor(root)}
                                </Text>
                                <Text style={styles.detailSectionMeta}>
                                  {count > 1 ? `${count} comments` : 'Show'}
                                </Text>
                              </Pressable>
                            )
                          }

                          const renderProjectComment = (
                            comment: DetailComment,
                            options: { nested?: boolean } = {}
                          ): ReactNode => {
                            const commentId = String(comment.id)
                            const isEditingComment =
                              SHOW_MOBILE_COMMENT_THREAD_TOOLS &&
                              projectEditingCommentId === commentId
                            return (
                              <View
                                key={commentId}
                                style={[
                                  styles.commentBlock,
                                  options.nested && styles.commentReplyBlock,
                                  comment.isResolved && styles.commentResolvedBlock
                                ]}
                              >
                                <Text style={styles.commentSource} numberOfLines={1}>
                                  {commentSourceLabel(comment)}
                                </Text>
                                <Text style={styles.commentMeta}>
                                  {commentAuthor(comment)}
                                  {commentDate(comment.createdAt)
                                    ? ` · ${commentDate(comment.createdAt)}`
                                    : ''}
                                </Text>
                                {isEditingComment ? (
                                  <>
                                    <TextInput
                                      style={[styles.input, styles.commentInput]}
                                      value={projectEditingCommentDraft}
                                      onChangeText={setProjectEditingCommentDraft}
                                      placeholder="Edit comment"
                                      placeholderTextColor={colors.textMuted}
                                      multiline
                                      textAlignVertical="top"
                                    />
                                    <View style={styles.inlineActionRow}>
                                      <Pressable
                                        style={styles.inlineSaveButtonCompact}
                                        disabled={
                                          projectMutating ||
                                          projectEditingCommentDraft.trim().length === 0
                                        }
                                        onPress={() =>
                                          void updateProjectRowComment(projectRowItem, comment)
                                        }
                                      >
                                        <Text style={styles.inlineSaveText}>Save</Text>
                                      </Pressable>
                                      <Pressable
                                        style={styles.inlineSaveButtonCompact}
                                        disabled={projectMutating}
                                        onPress={() => {
                                          setProjectEditingCommentId(null)
                                          setProjectEditingCommentDraft('')
                                        }}
                                      >
                                        <Text style={styles.inlineSaveText}>Cancel</Text>
                                      </Pressable>
                                    </View>
                                  </>
                                ) : (
                                  <>
                                    <MobileMarkdown content={comment.body} />
                                    {renderCommentReactions(comment)}
                                    {SHOW_MOBILE_COMMENT_THREAD_TOOLS ? (
                                      <View style={styles.inlineActionRow}>
                                        {projectRowType(projectRowItem) === 'pr' &&
                                        comment.threadId ? (
                                          <Pressable
                                            style={styles.inlineSaveButtonCompact}
                                            disabled={projectMutating}
                                            onPress={() =>
                                              void toggleProjectGitHubReviewThread(
                                                projectRowItem,
                                                comment
                                              )
                                            }
                                          >
                                            <Text style={styles.inlineSaveText}>
                                              {comment.isResolved
                                                ? 'Reopen thread'
                                                : 'Resolve thread'}
                                            </Text>
                                          </Pressable>
                                        ) : null}
                                        <TextInput
                                          style={[styles.input, styles.replyInput]}
                                          value={itemReplyDrafts[commentId] ?? ''}
                                          onChangeText={(next) =>
                                            setItemReplyDrafts((current) => ({
                                              ...current,
                                              [commentId]: next
                                            }))
                                          }
                                          placeholder="Reply"
                                          placeholderTextColor={colors.textMuted}
                                          multiline
                                          textAlignVertical="top"
                                        />
                                        <Pressable
                                          style={styles.inlineSaveButtonCompact}
                                          disabled={
                                            projectMutating ||
                                            !(itemReplyDrafts[commentId] ?? '').trim()
                                          }
                                          onPress={() =>
                                            void replyToProjectGitHubComment(
                                              projectRowItem,
                                              comment
                                            )
                                          }
                                        >
                                          <Text style={styles.inlineSaveText}>Reply</Text>
                                        </Pressable>
                                        <Pressable
                                          style={styles.inlineSaveButtonCompact}
                                          disabled={projectMutating}
                                          onPress={() => {
                                            setProjectEditingCommentId(commentId)
                                            setProjectEditingCommentDraft(comment.body)
                                          }}
                                        >
                                          <Text style={styles.inlineSaveText}>Edit</Text>
                                        </Pressable>
                                        <Pressable
                                          style={styles.inlineSaveButtonCompact}
                                          disabled={projectMutating}
                                          onPress={() =>
                                            void deleteProjectRowComment(projectRowItem, comment)
                                          }
                                        >
                                          <Text style={styles.inlineDeleteText}>Delete</Text>
                                        </Pressable>
                                      </View>
                                    ) : null}
                                  </>
                                )}
                              </View>
                            )
                          }

                          return (
                            <View key={groupId} style={styles.commentThreadGroup}>
                              {group.kind === 'thread'
                                ? [
                                    renderProjectComment(group.root),
                                    ...group.replies.map((reply) =>
                                      renderProjectComment(reply, { nested: true })
                                    )
                                  ]
                                : renderProjectComment(group.comment)}
                            </View>
                          )
                        })
                      )}
                      {renderCommentComposer({
                        value: projectCommentDraft,
                        onChangeText: setProjectCommentDraft,
                        disabled: projectMutating,
                        onSubmit: () => void addProjectRowComment(projectRowItem)
                      })}
                    </View>
                  ) : null}
                </>
              )}
            </View>

            <View style={styles.actionGroup}>
              {canCreateWorkspaceFromProjectRow(projectRowItem) ? (
                <Pressable
                  style={styles.actionRow}
                  disabled={creatingKey === `github-project:${projectRowItem.id}`}
                  onPress={() => void createWorkspaceFromProjectRow(projectRowItem)}
                >
                  <Plus size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Create Workspace</Text>
                </Pressable>
              ) : (
                <Text style={styles.emptyInlineText}>
                  Workspaces can only be created from GitHub issues and pull requests.
                </Text>
              )}

              {projectRowItem.content.url ? (
                <>
                  {canCreateWorkspaceFromProjectRow(projectRowItem) ? (
                    <View style={styles.actionSeparator} />
                  ) : null}
                  <Pressable
                    style={styles.actionRow}
                    onPress={() => {
                      if (projectRowItem.content.url) {
                        void Linking.openURL(projectRowItem.content.url)
                      }
                    }}
                  >
                    <ExternalLink size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>Open in GitHub</Text>
                  </Pressable>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    onPress={() =>
                      projectRowItem.content.url
                        ? void copyTaskLink(
                            `github-project:${projectRowItem.id}`,
                            projectRowItem.content.url
                          )
                        : undefined
                    }
                  >
                    <Copy size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>
                      {copiedLinkKey === `github-project:${projectRowItem.id}`
                        ? 'Copied'
                        : 'Copy GitHub link'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
              {projectRowType(projectRowItem) &&
              projectRowItem.content.state !== 'MERGED' &&
              projectRowItem.itemType !== 'DRAFT_ISSUE' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={projectMutating}
                    onPress={() => {
                      const nextState =
                        projectRowItem.content.state === 'CLOSED' ? 'open' : 'closed'
                      if (projectRowItem.itemType === 'PULL_REQUEST') {
                        setPendingHostedStateChange({
                          source: 'project',
                          row: projectRowItem,
                          nextState
                        })
                        return
                      }
                      setPendingHostedStateChange({
                        source: 'project',
                        row: projectRowItem,
                        nextState
                      })
                    }}
                  >
                    {projectRowItem.content.state === 'CLOSED' ? (
                      <RefreshCw size={16} color={colors.textPrimary} />
                    ) : (
                      <X size={16} color={colors.textPrimary} />
                    )}
                    <Text style={styles.actionText}>
                      {projectRowItem.content.state === 'CLOSED' ? 'Reopen item' : 'Close item'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
              {projectRowItem.itemType === 'PULL_REQUEST' &&
              projectRowItem.content.state !== 'CLOSED' &&
              projectRowItem.content.state !== 'MERGED' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={projectMutating || !projectRowHostedRepo}
                    onPress={() => setMergeMethodProjectRow(projectRowItem)}
                  >
                    <GitBranch size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>Merge pull request</Text>
                  </Pressable>
                  {!projectRowHostedRepo ? (
                    <Text style={styles.emptyInlineText}>
                      Merge requires this repository in Orca.
                    </Text>
                  ) : null}
                </>
              ) : null}
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <BottomDrawer visible={taskUiReady && actionItem != null} onClose={() => setActionItem(null)}>
        {actionItem ? (
          <View>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleRow}>
                <TaskProviderLogo
                  provider={actionItem.provider}
                  size={16}
                  color={colors.textPrimary}
                />
                <Text style={styles.sheetTitle} numberOfLines={2}>
                  {actionItem.title}
                </Text>
                <Pressable
                  style={styles.iconButton}
                  disabled={detailLoading}
                  accessibilityLabel="Refresh details"
                  onPress={() => setDetailRefreshSeq((current) => current + 1)}
                >
                  <RefreshCw
                    size={16}
                    color={detailLoading ? colors.textMuted : colors.textSecondary}
                  />
                </Pressable>
              </View>
              <Text style={styles.sheetSubtitle}>
                {taskKindLabel(actionItem)} · {actionItem.subtitle}
              </Text>
            </View>

            <View style={styles.detailGroup}>
              {detailLoading ? (
                <View style={styles.detailLoading}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : detailError ? (
                <Text style={styles.detailError}>{detailError}</Text>
              ) : detailPayload ? (
                <>
                  <View style={styles.detailMetaGrid}>
                    <View style={styles.detailMetaItem}>
                      <Text style={styles.detailMetaLabel}>Type</Text>
                      <Text style={styles.detailMetaValue}>{taskKindLabel(actionItem)}</Text>
                    </View>
                    <View style={styles.detailMetaItem}>
                      <Text style={styles.detailMetaLabel}>Status</Text>
                      <Text style={styles.detailMetaValue}>{actionItem.status}</Text>
                    </View>
                    {detailPayload.provider === 'linear' && detailPayload.assignee ? (
                      <View style={styles.detailMetaItem}>
                        <Text style={styles.detailMetaLabel}>Assignee</Text>
                        <Text style={styles.detailMetaValue}>{detailPayload.assignee}</Text>
                      </View>
                    ) : null}
                    {detailPayload.provider === 'linear' && detailPayload.project ? (
                      <View style={styles.detailMetaItem}>
                        <Text style={styles.detailMetaLabel}>Project</Text>
                        <Text style={styles.detailMetaValue}>{detailPayload.project.name}</Text>
                      </View>
                    ) : null}
                    {(detailPayload.provider === 'github' || detailPayload.provider === 'gitlab') &&
                    detailPayload.assignees.length > 0 ? (
                      <View style={styles.detailMetaItem}>
                        <Text style={styles.detailMetaLabel}>Assignees</Text>
                        <Text style={styles.detailMetaValue}>
                          {detailPayload.assignees.join(', ')}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  {SHOW_MOBILE_DETAIL_LABEL_CHIPS && detailPayload.labels.length > 0 ? (
                    <View style={styles.chipRow}>
                      {detailPayload.labels.map((label) => (
                        <View key={label} style={styles.detailChip}>
                          <Text style={styles.detailChipText}>{label}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>Description</Text>
                    {SHOW_MOBILE_DETAIL_METADATA_EDITORS &&
                    ((actionItem.provider === 'github' &&
                      detailPayload.provider === 'github' &&
                      (actionItem.source.type === 'issue' || actionItem.source.type === 'pr')) ||
                      (actionItem.provider === 'gitlab' &&
                        detailPayload.provider === 'gitlab' &&
                        (actionItem.source.type === 'issue' ||
                          actionItem.source.type === 'mr'))) ? (
                      <>
                        <TextInput
                          style={[styles.input, styles.bodyInput]}
                          value={itemBodyDraft}
                          onChangeText={setItemBodyDraft}
                          placeholder="Description"
                          placeholderTextColor={colors.textMuted}
                          multiline
                          textAlignVertical="top"
                        />
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={mutatingStatus || itemBodyDraft === detailPayload.body}
                          onPress={() => {
                            if (
                              actionItem.provider === 'github' &&
                              actionItem.source.type === 'pr'
                            ) {
                              void updateGitHubPullRequestMetadata(actionItem, {
                                body: itemBodyDraft
                              })
                              return
                            }
                            if (
                              actionItem.provider === 'github' &&
                              actionItem.source.type === 'issue'
                            ) {
                              void updateGitHubIssueMetadata(actionItem, {
                                body: itemBodyDraft
                              })
                              return
                            }
                            if (
                              actionItem.provider === 'gitlab' &&
                              (actionItem.source.type === 'issue' ||
                                actionItem.source.type === 'mr')
                            ) {
                              void updateGitLabIssueMetadata(actionItem, {
                                body: itemBodyDraft
                              })
                            }
                          }}
                        >
                          <Text style={styles.inlineSaveText}>Save description</Text>
                        </Pressable>
                        <MobileMarkdown content={itemBodyDraft} fallback="No description." />
                      </>
                    ) : (
                      <MobileMarkdown
                        content={
                          detailPayload.provider === 'linear'
                            ? detailPayload.description
                            : detailPayload.body
                        }
                        fallback="No description."
                      />
                    )}
                  </View>

                  {SHOW_MOBILE_DETAIL_METADATA_EDITORS &&
                  ((actionItem.provider === 'github' &&
                    detailPayload.provider === 'github' &&
                    (actionItem.source.type === 'issue' || actionItem.source.type === 'pr')) ||
                    (actionItem.provider === 'gitlab' &&
                      (actionItem.source.type === 'issue' || actionItem.source.type === 'mr') &&
                      detailPayload.provider === 'gitlab')) ? (
                    <>
                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Title</Text>
                        <TextInput
                          style={styles.input}
                          value={itemTitleDraft}
                          onChangeText={setItemTitleDraft}
                          placeholder="Title"
                          placeholderTextColor={colors.textMuted}
                        />
                        <Pressable
                          style={styles.inlineSaveButton}
                          disabled={
                            mutatingStatus ||
                            itemTitleDraft.trim().length === 0 ||
                            itemTitleDraft.trim() === actionItem.title
                          }
                          onPress={() => {
                            if (
                              actionItem.provider === 'github' &&
                              actionItem.source.type === 'pr'
                            ) {
                              void updateGitHubPullRequestMetadata(actionItem, {
                                title: itemTitleDraft.trim()
                              })
                              return
                            }
                            if (actionItem.provider === 'github') {
                              void updateGitHubIssueMetadata(actionItem, {
                                title: itemTitleDraft.trim()
                              })
                              return
                            }
                            if (actionItem.provider === 'gitlab') {
                              void updateGitLabIssueMetadata(actionItem, {
                                title: itemTitleDraft.trim()
                              })
                            }
                          }}
                        >
                          <Text style={styles.inlineSaveText}>Save title</Text>
                        </Pressable>
                      </View>

                      <View style={styles.detailSection}>
                        <View style={styles.detailSectionHeader}>
                          <Text style={styles.detailSectionTitle}>Labels</Text>
                          <Text style={styles.detailSectionMeta}>
                            {detailPayload.labels.length || 'None'}
                          </Text>
                        </View>
                        {actionItem.provider === 'github' ? (
                          itemLabelsLoading ? (
                            <View style={styles.detailLoadingInline}>
                              <ActivityIndicator size="small" color={colors.textSecondary} />
                              <Text style={styles.detailMuted}>Loading labels...</Text>
                            </View>
                          ) : itemLabelsError ? (
                            <Text style={styles.detailError}>{itemLabelsError}</Text>
                          ) : itemAvailableLabels.length === 0 ? (
                            <Text style={styles.detailMuted}>No labels in this repository.</Text>
                          ) : (
                            <View style={styles.chipRow}>
                              {[...new Set([...itemAvailableLabels, ...detailPayload.labels])].map(
                                (label) => {
                                  const selected = detailPayload.labels.includes(label)
                                  return (
                                    <Pressable
                                      key={label}
                                      style={[
                                        styles.detailChip,
                                        selected ? styles.detailChipSelected : undefined
                                      ]}
                                      disabled={mutatingStatus}
                                      onPress={() =>
                                        void updateGitHubIssueMetadata(
                                          actionItem,
                                          selected
                                            ? { removeLabels: [label] }
                                            : { addLabels: [label] }
                                        )
                                      }
                                    >
                                      <View style={styles.issueTypeChipContent}>
                                        {selected ? (
                                          <Check size={12} color={colors.accentBlue} />
                                        ) : null}
                                        <Text style={styles.detailChipText}>{label}</Text>
                                      </View>
                                    </Pressable>
                                  )
                                }
                              )}
                            </View>
                          )
                        ) : (
                          <>
                            <TextInput
                              style={styles.input}
                              value={itemAddLabelsDraft}
                              onChangeText={setItemAddLabelsDraft}
                              placeholder="Add labels, comma separated"
                              placeholderTextColor={colors.textMuted}
                              autoCapitalize="none"
                            />
                            <TextInput
                              style={[styles.input, styles.stackedInput]}
                              value={itemRemoveLabelsDraft}
                              onChangeText={setItemRemoveLabelsDraft}
                              placeholder="Remove labels, comma separated"
                              placeholderTextColor={colors.textMuted}
                              autoCapitalize="none"
                            />
                            <Pressable
                              style={styles.inlineSaveButton}
                              disabled={
                                mutatingStatus ||
                                (splitCommaList(itemAddLabelsDraft).length === 0 &&
                                  splitCommaList(itemRemoveLabelsDraft).length === 0)
                              }
                              onPress={() =>
                                void updateGitLabIssueMetadata(actionItem, {
                                  addLabels: splitCommaList(itemAddLabelsDraft),
                                  removeLabels: splitCommaList(itemRemoveLabelsDraft)
                                })
                              }
                            >
                              <Text style={styles.inlineSaveText}>Update labels</Text>
                            </Pressable>
                          </>
                        )}
                      </View>

                      <View style={styles.detailSection}>
                        <View style={styles.detailSectionHeader}>
                          <Text style={styles.detailSectionTitle}>Assignees</Text>
                          <Text style={styles.detailSectionMeta}>
                            {detailPayload.assignees.length || 'None'}
                          </Text>
                        </View>
                        {actionItem.provider === 'github' ? (
                          itemAssignableUsersLoading ? (
                            <View style={styles.detailLoadingInline}>
                              <ActivityIndicator size="small" color={colors.textSecondary} />
                              <Text style={styles.detailMuted}>Loading assignees...</Text>
                            </View>
                          ) : itemAssignableUsersError ? (
                            <Text style={styles.detailError}>{itemAssignableUsersError}</Text>
                          ) : itemAssignableUsers.length === 0 ? (
                            <Text style={styles.detailMuted}>
                              No assignable users found for this repository.
                            </Text>
                          ) : (
                            <View style={styles.chipRow}>
                              {[
                                ...new Map(
                                  [
                                    ...itemAssignableUsers,
                                    ...detailPayload.assignees.map((login) => ({
                                      login,
                                      name: null,
                                      avatarUrl: null
                                    }))
                                  ].map((user) => [user.login, user])
                                ).values()
                              ].map((user) => {
                                const selected = detailPayload.assignees.includes(user.login)
                                return (
                                  <Pressable
                                    key={user.login}
                                    style={[
                                      styles.detailChip,
                                      selected ? styles.detailChipSelected : undefined
                                    ]}
                                    disabled={mutatingStatus}
                                    onPress={() =>
                                      void updateGitHubIssueMetadata(
                                        actionItem,
                                        selected
                                          ? { removeAssignees: [user.login] }
                                          : { addAssignees: [user.login] }
                                      )
                                    }
                                  >
                                    <View style={styles.issueTypeChipContent}>
                                      {selected ? (
                                        <Check size={12} color={colors.accentBlue} />
                                      ) : null}
                                      <Text style={styles.detailChipText}>{user.login}</Text>
                                    </View>
                                  </Pressable>
                                )
                              })}
                            </View>
                          )
                        ) : actionItem.source.type === 'issue' ? (
                          <>
                            <TextInput
                              style={styles.input}
                              value={itemAddAssigneesDraft}
                              onChangeText={setItemAddAssigneesDraft}
                              placeholder="Add usernames, comma separated"
                              placeholderTextColor={colors.textMuted}
                              autoCapitalize="none"
                            />
                            <TextInput
                              style={[styles.input, styles.stackedInput]}
                              value={itemRemoveAssigneesDraft}
                              onChangeText={setItemRemoveAssigneesDraft}
                              placeholder="Remove usernames, comma separated"
                              placeholderTextColor={colors.textMuted}
                              autoCapitalize="none"
                            />
                            <Pressable
                              style={styles.inlineSaveButton}
                              disabled={
                                mutatingStatus ||
                                (splitCommaList(itemAddAssigneesDraft).length === 0 &&
                                  splitCommaList(itemRemoveAssigneesDraft).length === 0)
                              }
                              onPress={() =>
                                void updateGitLabIssueMetadata(actionItem, {
                                  addAssignees: splitCommaList(itemAddAssigneesDraft),
                                  removeAssignees: splitCommaList(itemRemoveAssigneesDraft)
                                })
                              }
                            >
                              <Text style={styles.inlineSaveText}>Update assignees</Text>
                            </Pressable>
                          </>
                        ) : null}
                      </View>
                    </>
                  ) : null}

                  {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
                  actionItem.provider === 'github' &&
                  actionItem.source.type === 'pr' ? (
                    <View style={styles.detailSection}>
                      <View style={styles.detailSectionHeader}>
                        <Text style={styles.detailSectionTitle}>Reviewers</Text>
                        {detailPayload.provider === 'github' ? (
                          <Text style={styles.detailSectionMeta}>
                            {getGitHubReviewSummary(detailPayload)}
                          </Text>
                        ) : null}
                      </View>
                      {detailPayload.provider === 'github' ? (
                        getGitHubReviewerRows(detailPayload).length === 0 ? (
                          <Text style={styles.detailMuted}>No reviewers requested.</Text>
                        ) : (
                          getGitHubReviewerRows(detailPayload).map((reviewer) => (
                            <View key={reviewer.login} style={styles.reviewerRow}>
                              <View style={styles.reviewerAvatar}>
                                <Text style={styles.reviewerAvatarText}>
                                  {reviewer.login.slice(0, 1).toUpperCase()}
                                </Text>
                              </View>
                              <View style={styles.reviewerInfo}>
                                <Text style={styles.reviewerName} numberOfLines={1}>
                                  {reviewer.login}
                                </Text>
                                {reviewer.name ? (
                                  <Text style={styles.reviewerMeta} numberOfLines={1}>
                                    {reviewer.name}
                                  </Text>
                                ) : null}
                              </View>
                              <Text style={styles.reviewerState}>{reviewer.stateLabel}</Text>
                            </View>
                          ))
                        )
                      ) : null}
                      {itemAssignableUsersLoading ? (
                        <View style={styles.detailLoadingInline}>
                          <ActivityIndicator size="small" color={colors.textSecondary} />
                          <Text style={styles.detailMuted}>Loading reviewers...</Text>
                        </View>
                      ) : itemAssignableUsersError ? (
                        <Text style={styles.detailError}>{itemAssignableUsersError}</Text>
                      ) : itemReviewerCandidates.length === 0 ? (
                        <Text style={styles.detailMuted}>No reviewer suggestions found.</Text>
                      ) : (
                        <View style={styles.chipRow}>
                          {itemReviewerCandidates.map((user) => {
                            const selected = itemSelectedReviewerLogins.has(
                              user.login.trim().toLowerCase()
                            )
                            return (
                              <Pressable
                                key={user.login}
                                style={[
                                  styles.detailChip,
                                  selected ? styles.detailChipSelected : undefined
                                ]}
                                disabled={mutatingStatus || selected}
                                onPress={() =>
                                  void requestGitHubReviewers(actionItem, [user.login])
                                }
                              >
                                <View style={styles.issueTypeChipContent}>
                                  {selected ? <Check size={12} color={colors.accentBlue} /> : null}
                                  <Text style={styles.detailChipText}>{user.login}</Text>
                                </View>
                              </Pressable>
                            )
                          })}
                        </View>
                      )}
                      <TextInput
                        style={styles.input}
                        value={itemReviewersDraft}
                        onChangeText={setItemReviewersDraft}
                        placeholder="Request reviewers"
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="none"
                      />
                      <Pressable
                        style={styles.inlineSaveButton}
                        disabled={
                          mutatingStatus || splitReviewerList(itemReviewersDraft).length === 0
                        }
                        onPress={() => void requestGitHubReviewers(actionItem)}
                      >
                        <Text style={styles.inlineSaveText}>Request review</Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
                  detailPayload.provider === 'github' &&
                  actionItem.provider === 'github' &&
                  actionItem.source.type === 'pr' ? (
                    <View style={styles.detailSection}>
                      <View style={styles.detailSectionHeader}>
                        <Text style={styles.detailSectionTitle}>Checks</Text>
                        <View style={styles.inlineActionRow}>
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            disabled={mutatingStatus}
                            onPress={() => void refreshGitHubChecks(actionItem)}
                          >
                            <Text style={styles.inlineSaveText}>Refresh</Text>
                          </Pressable>
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            disabled={
                              mutatingStatus || !detailPayload.checks.some(isFailedGitHubCheck)
                            }
                            onPress={() => void rerunGitHubChecks(actionItem, true)}
                          >
                            <Text style={styles.inlineSaveText}>Rerun failed</Text>
                          </Pressable>
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            disabled={mutatingStatus || detailPayload.checks.length === 0}
                            onPress={() => void rerunGitHubChecks(actionItem, false)}
                          >
                            <Text style={styles.inlineSaveText}>Rerun all</Text>
                          </Pressable>
                        </View>
                      </View>
                      {detailPayload.checks.length === 0 ? (
                        <Text style={styles.detailMuted}>No checks found.</Text>
                      ) : (
                        detailPayload.checks.map((check) => (
                          <Pressable
                            key={`${check.name}:${check.status}:${check.url ?? ''}`}
                            style={styles.fileActionRow}
                            disabled={!check.url}
                            onPress={() => {
                              if (check.url) {
                                void Linking.openURL(check.url)
                              }
                            }}
                          >
                            <Text style={styles.detailLine} numberOfLines={2}>
                              {check.name} · {check.conclusion ?? check.status}
                            </Text>
                            {check.url ? (
                              <ExternalLink size={14} color={colors.textSecondary} />
                            ) : null}
                          </Pressable>
                        ))
                      )}
                    </View>
                  ) : null}

                  {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
                  detailPayload.provider === 'github' &&
                  detailPayload.files.length > 0 ? (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>Changed files</Text>
                      {detailPayload.files.map((file) =>
                        actionItem.provider === 'github' && actionItem.source.type === 'pr' ? (
                          <View key={file.path} style={styles.fileCard}>
                            <Pressable
                              style={styles.fileActionRow}
                              disabled={mutatingStatus}
                              onPress={() => void toggleGitHubFileExpansion(actionItem, file)}
                            >
                              <Text style={styles.detailLine}>
                                {file.path}
                                {typeof file.additions === 'number' ||
                                typeof file.deletions === 'number'
                                  ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
                                  : ''}
                              </Text>
                              <Text style={styles.detailSectionMeta}>
                                {expandedPrFilePath === file.path ? 'Hide' : 'View'}
                              </Text>
                            </Pressable>
                            <Pressable
                              style={styles.inlineSaveButtonCompact}
                              disabled={mutatingStatus || !detailPayload.pullRequestId}
                              onPress={() => void toggleGitHubFileViewed(actionItem, file)}
                            >
                              <Text style={styles.inlineSaveText}>
                                {file.viewerViewedState === 'VIEWED'
                                  ? 'Mark unviewed'
                                  : 'Mark viewed'}
                              </Text>
                            </Pressable>
                            {expandedPrFilePath === file.path ? (
                              <View style={styles.filePreview}>
                                {prFileLoadingPath === file.path ? (
                                  <ActivityIndicator size="small" color={colors.textSecondary} />
                                ) : prFileContents[file.path]?.originalIsBinary ||
                                  prFileContents[file.path]?.modifiedIsBinary ? (
                                  <Text style={styles.detailMuted}>Binary file.</Text>
                                ) : prFileContents[file.path] ? (
                                  <GitHubPrFileDiff
                                    filePath={file.path}
                                    contents={prFileContents[file.path]}
                                    commentDrafts={prFileCommentDrafts}
                                    disabled={mutatingStatus}
                                    onCommentDraftChange={(draftKey, next) =>
                                      setPrFileCommentDrafts((current) => ({
                                        ...current,
                                        [draftKey]: next
                                      }))
                                    }
                                    onSubmitComment={(line) =>
                                      void addGitHubFileReviewComment(actionItem, file, line)
                                    }
                                  />
                                ) : (
                                  <Text style={styles.detailMuted}>File contents unavailable.</Text>
                                )}
                              </View>
                            ) : null}
                          </View>
                        ) : (
                          <Text key={file.path} style={styles.detailLine}>
                            {file.path}
                            {typeof file.additions === 'number' ||
                            typeof file.deletions === 'number'
                              ? ` · +${file.additions ?? 0} -${file.deletions ?? 0}`
                              : ''}
                          </Text>
                        )
                      )}
                    </View>
                  ) : null}

                  {SHOW_MOBILE_DETAIL_REVIEW_PANELS &&
                  detailPayload.provider === 'gitlab' &&
                  actionItem.provider === 'gitlab' &&
                  actionItem.source.type === 'mr' ? (
                    <View style={styles.detailSection}>
                      <View style={styles.detailSectionHeader}>
                        <Text style={styles.detailSectionTitle}>Pipeline</Text>
                        <Text style={styles.detailSectionMeta}>
                          {detailPayload.pipelineJobs.length
                            ? `${detailPayload.pipelineJobs.length} jobs`
                            : 'None'}
                        </Text>
                      </View>
                      {detailPayload.pipelineJobs.length === 0 ? (
                        <Text style={styles.detailMuted}>No pipeline runs for this MR.</Text>
                      ) : (
                        detailPayload.pipelineJobs.map((job) => {
                          const duration = formatDurationSeconds(job.duration)
                          return (
                            <Pressable
                              key={`${job.id ?? job.stage}:${job.name}`}
                              style={styles.fileCard}
                              disabled={!job.webUrl}
                              onPress={() => {
                                if (job.webUrl) {
                                  void Linking.openURL(job.webUrl)
                                }
                              }}
                            >
                              <View style={styles.fileActionRow}>
                                <Text style={styles.detailLine} numberOfLines={2}>
                                  {job.name}
                                </Text>
                                <View
                                  style={[
                                    styles.pipelineStatusChip,
                                    getGitLabPipelineStatusStyle(job.status)
                                  ]}
                                >
                                  <Text style={styles.pipelineStatusText}>{job.status}</Text>
                                </View>
                              </View>
                              <Text style={styles.detailMuted}>
                                {[job.stage, duration].filter(Boolean).join(' · ')}
                              </Text>
                            </Pressable>
                          )
                        })
                      )}
                    </View>
                  ) : null}

                  {SHOW_MOBILE_LINEAR_DETAIL_TOOLS &&
                  detailPayload.provider === 'linear' &&
                  actionItem.provider === 'linear' ? (
                    <View style={styles.detailSection}>
                      <View style={styles.detailSectionHeader}>
                        <Text style={styles.detailSectionTitle}>Sub-issues</Text>
                        <Text style={styles.detailSectionMeta}>
                          {detailPayload.children.length || 'None'}
                        </Text>
                      </View>
                      {detailPayload.children.length === 0 ? (
                        <Text style={styles.detailMuted}>No sub-issues.</Text>
                      ) : (
                        detailPayload.children.map((child) => (
                          <Pressable
                            key={child.id}
                            style={styles.fileActionRow}
                            disabled={mutatingStatus}
                            onPress={() =>
                              void openLinearSubIssue(child, actionItem.source.workspaceId)
                            }
                          >
                            <Text style={styles.detailLine}>
                              {child.identifier} · {child.title}
                            </Text>
                            <Text style={styles.detailSectionMeta}>Open</Text>
                          </Pressable>
                        ))
                      )}
                      <TextInput
                        style={[styles.input, styles.stackedInput]}
                        value={linearSubIssueTitle}
                        onChangeText={setLinearSubIssueTitle}
                        placeholder="Sub-issue title"
                        placeholderTextColor={colors.textMuted}
                      />
                      <Pressable
                        style={styles.inlineSaveButton}
                        disabled={mutatingStatus || linearSubIssueTitle.trim().length === 0}
                        onPress={() => void createLinearSubIssue(actionItem)}
                      >
                        <Text style={styles.inlineSaveText}>Add sub-issue</Text>
                      </Pressable>
                    </View>
                  ) : null}

                  <View style={styles.detailSection}>
                    <View style={styles.detailSectionHeader}>
                      <Text style={styles.detailSectionTitle}>Discussion</Text>
                      <Text style={styles.detailSectionMeta}>
                        {discussionSummary(detailPayload.comments.length)}
                      </Text>
                    </View>
                    {detailPayload.comments.length === 0 ? (
                      <Text style={styles.detailMuted}>No comments.</Text>
                    ) : (
                      detailCommentGroups.map(renderDetailCommentGroup)
                    )}
                    {(detailPayload.provider === 'github' && actionItem.provider === 'github') ||
                    (detailPayload.provider === 'gitlab' && actionItem.provider === 'gitlab')
                      ? renderCommentComposer({
                          value: itemCommentDraft,
                          onChangeText: setItemCommentDraft,
                          disabled: mutatingStatus,
                          onSubmit: () => void addHostedItemComment(actionItem)
                        })
                      : null}
                    {detailPayload.provider === 'linear' && actionItem.provider === 'linear'
                      ? renderCommentComposer({
                          value: linearCommentDraft,
                          onChangeText: setLinearCommentDraft,
                          disabled: mutatingStatus,
                          onSubmit: () => void addLinearComment(actionItem)
                        })
                      : null}
                  </View>
                </>
              ) : null}
            </View>

            <View style={styles.actionGroup}>
              <Pressable
                style={styles.actionRow}
                disabled={creatingKey === actionItem.key}
                onPress={() => {
                  if (actionItem.provider === 'linear' && workspaceRepos.length > 1) {
                    setWorkspaceRepoPickerItem(actionItem)
                    return
                  }
                  openWorkspaceCreate(actionItem)
                }}
              >
                <Plus size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>
                  {creatingKey === actionItem.key ? 'Creating...' : 'Create Workspace'}
                </Text>
              </Pressable>

              <View style={styles.actionSeparator} />
              <Pressable
                style={styles.actionRow}
                onPress={() => void Linking.openURL(actionItem.source.url)}
              >
                <ExternalLink size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>{taskExternalOpenLabel(actionItem)}</Text>
              </Pressable>

              {actionItem.provider === 'linear' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    onPress={() =>
                      void copyTextToClipboard(
                        `linear-url:${actionItem.key}`,
                        actionItem.source.url
                      )
                    }
                  >
                    <Copy size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>
                      {copiedLinkKey === `linear-url:${actionItem.key}`
                        ? 'Copied'
                        : 'Copy Linear link'}
                    </Text>
                  </Pressable>
                </>
              ) : null}

              {actionItem.provider === 'github' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    onPress={() =>
                      void copyTaskLink(`task:${actionItem.key}`, actionItem.source.url)
                    }
                  >
                    <Copy size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>
                      {copiedLinkKey === `task:${actionItem.key}` ? 'Copied' : 'Copy GitHub link'}
                    </Text>
                  </Pressable>
                </>
              ) : null}

              {actionItem.provider === 'github' && actionItem.source.state !== 'merged' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={mutatingStatus}
                    onPress={() => {
                      const githubItem = actionItem as Extract<TaskItem, { provider: 'github' }>
                      setPendingHostedStateChange({
                        source: 'task',
                        item: githubItem,
                        nextState: githubItem.source.state === 'closed' ? 'open' : 'closed'
                      })
                    }}
                  >
                    {actionItem.source.state === 'closed' ? (
                      <RefreshCw size={16} color={colors.textPrimary} />
                    ) : (
                      <X size={16} color={colors.textPrimary} />
                    )}
                    <Text style={styles.actionText}>{taskStatusActionLabel(actionItem)}</Text>
                  </Pressable>
                </>
              ) : null}

              {actionItem.provider === 'github' &&
              actionItem.source.type === 'pr' &&
              actionItem.source.state === 'open' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={mutatingStatus || isGitHubPrMergeBlocked(actionItem)}
                    onPress={() =>
                      setMergeMethodTaskItem(
                        actionItem as Extract<TaskItem, { provider: 'github' }>
                      )
                    }
                  >
                    <GitBranch size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>Merge pull request</Text>
                  </Pressable>
                  {isGitHubPrMergeBlocked(actionItem) ? (
                    <Text style={styles.emptyInlineText}>GitHub reports merge conflicts.</Text>
                  ) : null}
                </>
              ) : null}

              {actionItem.provider === 'gitlab' &&
              actionItem.source.state !== 'merged' &&
              actionItem.source.state !== 'locked' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={mutatingStatus}
                    onPress={() => {
                      const gitlabItem = actionItem as Extract<TaskItem, { provider: 'gitlab' }>
                      setPendingHostedStateChange({
                        source: 'task',
                        item: gitlabItem,
                        nextState: gitlabItem.source.state === 'closed' ? 'opened' : 'closed'
                      })
                    }}
                  >
                    {actionItem.source.state === 'closed' ? (
                      <RefreshCw size={16} color={colors.textPrimary} />
                    ) : (
                      <X size={16} color={colors.textPrimary} />
                    )}
                    <Text style={styles.actionText}>{taskStatusActionLabel(actionItem)}</Text>
                  </Pressable>
                </>
              ) : null}

              {actionItem.provider === 'gitlab' &&
              actionItem.source.type === 'mr' &&
              actionItem.source.state === 'opened' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={mutatingStatus}
                    onPress={() =>
                      setMergeMethodTaskItem(
                        actionItem as Extract<TaskItem, { provider: 'gitlab' }>
                      )
                    }
                  >
                    <GitBranch size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>Merge merge request</Text>
                  </Pressable>
                </>
              ) : null}

              {actionItem.provider === 'linear' ? (
                <>
                  <View style={styles.actionSeparator} />
                  <Pressable
                    style={styles.actionRow}
                    disabled={mutatingStatus}
                    onPress={() => {
                      setLinearStatusPickerItem(
                        actionItem as Extract<TaskItem, { provider: 'linear' }>
                      )
                    }}
                  >
                    <GitBranch size={16} color={colors.textPrimary} />
                    <Text style={styles.actionText}>Change status</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
        ) : null}
      </BottomDrawer>

      <ActionSheetModal
        visible={taskUiReady && mergeMethodProjectRow != null}
        title="Merge method"
        message="Choose how this pull request should be merged."
        actions={
          mergeMethodProjectRow
            ? (['squash', 'merge', 'rebase'] as const).map((method) => ({
                label: getHostedReviewMergeMethodLabel(method),
                icon: GitBranch,
                onPress: () => {
                  setPendingProjectGitHubMerge({ row: mergeMethodProjectRow, method })
                }
              }))
            : []
        }
        onClose={() => setMergeMethodProjectRow(null)}
      />
      <ActionSheetModal
        visible={taskUiReady && mergeMethodTaskItem != null}
        title="Merge method"
        message={
          mergeMethodTaskItem?.provider === 'gitlab'
            ? 'Choose how this merge request should be merged.'
            : 'Choose how this pull request should be merged.'
        }
        actions={
          mergeMethodTaskItem
            ? (mergeMethodTaskItem.provider === 'gitlab'
                ? (['merge', 'squash', 'rebase'] as const)
                : (['squash', 'merge', 'rebase'] as const)
              ).map((method) => ({
                label:
                  mergeMethodTaskItem.provider === 'gitlab' && method === 'merge'
                    ? 'Merge'
                    : getHostedReviewMergeMethodLabel(method),
                icon: GitBranch,
                onPress: () => {
                  const item = mergeMethodTaskItem
                  setPendingHostedMerge({ item, method })
                }
              }))
            : []
        }
        onClose={() => setMergeMethodTaskItem(null)}
      />
      <ConfirmModal
        visible={taskUiReady && pendingHostedMerge != null}
        title={
          pendingHostedMerge?.item.provider === 'gitlab' ? 'Merge Request' : 'Merge Pull Request'
        }
        message={pendingHostedMerge ? getHostedMergeConfirmMessage(pendingHostedMerge) : undefined}
        confirmLabel={
          pendingHostedMerge ? getHostedReviewMergeMethodLabel(pendingHostedMerge.method) : 'Merge'
        }
        onConfirm={() => {
          if (!taskUiReady || !pendingHostedMerge) {
            return
          }
          void mergeHostedReview(pendingHostedMerge.item, pendingHostedMerge.method)
        }}
        onCancel={() => setPendingHostedMerge(null)}
      />
      <ConfirmModal
        visible={taskUiReady && pendingProjectGitHubMerge != null}
        title="Merge Pull Request"
        message={
          pendingProjectGitHubMerge
            ? getProjectGitHubMergeConfirmMessage(pendingProjectGitHubMerge)
            : undefined
        }
        confirmLabel={
          pendingProjectGitHubMerge
            ? getHostedReviewMergeMethodLabel(pendingProjectGitHubMerge.method)
            : 'Merge'
        }
        onConfirm={() => {
          if (!taskUiReady || !pendingProjectGitHubMerge) {
            return
          }
          void mergeProjectGitHubPullRequest(
            pendingProjectGitHubMerge.row,
            pendingProjectGitHubMerge.method
          )
        }}
        onCancel={() => setPendingProjectGitHubMerge(null)}
      />
      <ConfirmModal
        visible={taskUiReady && pendingHostedStateChange != null}
        title={
          pendingHostedStateChange
            ? getHostedStateConfirmTitle(pendingHostedStateChange)
            : 'Update Item'
        }
        message={
          pendingHostedStateChange
            ? getHostedStateConfirmMessage(pendingHostedStateChange)
            : undefined
        }
        confirmLabel={
          pendingHostedStateChange
            ? getHostedStateConfirmLabel(pendingHostedStateChange)
            : 'Confirm'
        }
        destructive={pendingHostedStateChange?.nextState === 'closed'}
        onConfirm={() => {
          if (!taskUiReady || !pendingHostedStateChange) {
            return
          }
          if (pendingHostedStateChange.source === 'task') {
            if (pendingHostedStateChange.item.provider === 'gitlab') {
              void toggleGitLabStatus(pendingHostedStateChange.item)
              return
            }
            void toggleGitHubStatus(pendingHostedStateChange.item)
            return
          }
          void mutateProjectRowIssueOrPr(pendingHostedStateChange.row, {
            state: pendingHostedStateChange.nextState
          })
        }}
        onCancel={() => setPendingHostedStateChange(null)}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    minHeight: 38,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center'
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2
  },
  toolbarScroll: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  segmentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs
  },
  segmentIconButton: {
    width: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  segmentCountPill: {
    minWidth: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm
  },
  segmentRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  segmentButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  segmentSecondaryText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 2
  },
  errorBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  errorText: {
    color: colors.statusRed,
    fontSize: 13
  },
  sourceErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceErrorCopy: {
    flex: 1,
    minWidth: 0
  },
  sourceErrorText: {
    color: colors.statusAmber,
    fontSize: 13,
    fontWeight: '600'
  },
  sourceErrorSlug: {
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  sourceErrorMessage: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: 12
  },
  sourceErrorRetry: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sourceErrorRetryText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  sourceNoticeBanner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sourceNoticeText: {
    color: colors.statusAmber,
    fontSize: 13
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  centeredHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    maxWidth: 280,
    textAlign: 'center'
  },
  centerActionButton: {
    marginTop: spacing.md,
    minWidth: 160
  },
  list: {
    paddingTop: spacing.xs
  },
  repoSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.bgBase
  },
  repoSectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  repoSectionTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 26,
    marginRight: spacing.lg
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2
  },
  taskRowPressed: {
    backgroundColor: colors.bgRaised
  },
  taskIcon: {
    width: 20,
    paddingTop: 3,
    marginRight: spacing.sm,
    alignItems: 'center'
  },
  taskMain: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.sm
  },
  taskTitleRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  taskTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 18
  },
  updatedAt: {
    fontSize: 11,
    color: colors.textMuted,
    paddingTop: 2
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: spacing.xs
  },
  repoDot: {
    width: 7,
    height: 7,
    borderRadius: 4
  },
  pickerRepoDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5
  },
  subtitle: {
    flex: 1,
    fontSize: 11,
    color: colors.textSecondary
  },
  branchMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3,
    minWidth: 0
  },
  branchMetaText: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 180,
    fontSize: 11,
    color: colors.textPrimary
  },
  branchMetaBase: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 10,
    color: colors.textMuted
  },
  prSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs + 1
  },
  prSignalChip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2
  },
  prSignalSuccess: {
    borderColor: colors.statusGreen
  },
  prSignalWarning: {
    borderColor: colors.statusAmber
  },
  prSignalDanger: {
    borderColor: colors.statusRed
  },
  prSignalText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600'
  },
  statusPill: {
    maxWidth: 112,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  statusPillSelf: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginTop: spacing.sm
  },
  linearStatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  linearStateDot: {
    width: 7,
    height: 7,
    borderRadius: 4
  },
  linearListTrailing: {
    alignItems: 'flex-end',
    gap: spacing.xs
  },
  taskRowTrailing: {
    alignItems: 'flex-end',
    gap: spacing.xs
  },
  statusText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  statusTextFlex: {
    flex: 1,
    minWidth: 0
  },
  paginationFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm
  },
  paginationButton: {
    width: 44,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm
  },
  paginationButtonDisabled: {
    opacity: 0.45
  },
  paginationLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: 'center'
  },
  paginationLabelButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: radii.button,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm
  },
  boardContainer: {
    gap: spacing.md,
    padding: spacing.md
  },
  boardColumn: {
    width: 280,
    maxHeight: '100%',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  boardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  boardTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  boardCount: {
    color: colors.textMuted,
    fontSize: 11
  },
  boardCard: {
    margin: spacing.sm,
    marginBottom: 0,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    padding: spacing.md
  },
  repoPickerGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  pagePickerList: {
    maxHeight: 420,
    backgroundColor: colors.bgPanel,
    borderRadius: 12
  },
  projectPickerControls: {
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  projectWarningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.statusAmber,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  projectWarningTextWrap: {
    flex: 1,
    minWidth: 0
  },
  projectWarningTitle: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  projectWarningText: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2
  },
  projectDataNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  projectDataNoticeText: {
    flex: 1,
    color: colors.statusAmber,
    fontSize: 13
  },
  projectGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  projectGroupChevronCollapsed: {
    transform: [{ rotate: '-90deg' }]
  },
  projectGroupTitle: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  projectGroupMeta: {
    color: colors.textMuted,
    fontSize: 11
  },
  projectFieldPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  projectFieldPill: {
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  projectFieldPillText: {
    color: colors.textSecondary,
    fontSize: 11
  },
  projectFieldPillEmptyText: {
    color: colors.textMuted
  },
  projectPasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  projectPasteInput: {
    flex: 1
  },
  projectPasteButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  pickerRowSelected: {
    backgroundColor: colors.bgRaised
  },
  pickerRowContent: {
    flex: 1,
    minWidth: 0
  },
  pickerRowLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  pickerRowSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  pickerRowWithAction: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  pickerRowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  pickerCheck: {
    width: 18,
    alignItems: 'center'
  },
  pickerContent: {
    flex: 1,
    minWidth: 0
  },
  pickerLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  monoText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  pickerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  iconActionButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  groupSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  repoPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  repoPickerTextWrap: {
    flex: 1,
    minWidth: 0
  },
  repoPickerTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  repoPickerSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  sheetHeader: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 20
  },
  sheetSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  detailGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md
  },
  detailLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  detailLoadingInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  detailError: {
    color: colors.statusRed,
    fontSize: 13
  },
  detailMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  detailMetaItem: {
    minWidth: 96,
    flexGrow: 1
  },
  detailMetaLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  detailMetaValue: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  detailChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  detailChipSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.bgRaised
  },
  detailChipText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  issueTypeChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  issueTypeDot: {
    width: 7,
    height: 7,
    borderRadius: 999
  },
  detailSection: {
    gap: spacing.xs
  },
  detailSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  detailSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  detailSectionMeta: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textMuted
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonDisabled: {
    opacity: 0.55
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  fieldButtonText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  workspaceCreateForm: {
    gap: 0
  },
  workspaceCreateField: {
    marginBottom: spacing.md
  },
  workspaceCreateLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  workspaceCreateLabelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  workspaceAdvancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs
  },
  workspaceAdvancedText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  workspaceCreateActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  workspaceCreateButton: {
    minWidth: 160,
    paddingHorizontal: spacing.lg
  },
  sshConnectCard: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  sshStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sshStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  sshStatusDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshStatusDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshStatusDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshStatusCopy: {
    flex: 1,
    minWidth: 0
  },
  sshStatusTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  reviewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  reviewerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  reviewerAvatarText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary
  },
  reviewerInfo: {
    flex: 1,
    minWidth: 0
  },
  reviewerName: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reviewerMeta: {
    fontSize: 11,
    color: colors.textMuted
  },
  reviewerState: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textSecondary
  },
  projectFieldCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  projectFieldName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  projectFieldValue: {
    maxWidth: 140,
    fontSize: 12,
    color: colors.textMuted
  },
  projectIterationList: {
    gap: spacing.xs
  },
  projectIterationCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  detailLine: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary
  },
  fileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 2
  },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  pipelineStatusChip: {
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  pipelineStatusSuccess: {
    borderColor: colors.statusGreen
  },
  pipelineStatusWarning: {
    borderColor: colors.statusAmber
  },
  pipelineStatusDanger: {
    borderColor: colors.statusRed
  },
  pipelineStatusActive: {
    borderColor: colors.accentBlue
  },
  pipelineStatusText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  filePreview: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  fileDiff: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    overflow: 'hidden'
  },
  diffLineBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  diffLineAdded: {
    borderLeftColor: colors.statusGreen
  },
  diffLineRemoved: {
    borderLeftColor: colors.statusRed
  },
  diffCodeRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'flex-start'
  },
  diffLineNumbers: {
    width: 76,
    flexShrink: 0,
    fontFamily: typography.monoFamily,
    fontSize: 10,
    lineHeight: 16,
    color: colors.textMuted
  },
  codeLine: {
    flex: 1,
    fontFamily: typography.monoFamily,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary
  },
  diffCodeAdded: {
    color: colors.statusGreen
  },
  diffCodeRemoved: {
    color: colors.statusRed
  },
  detailMuted: {
    fontSize: 12,
    color: colors.textSecondary
  },
  commentBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.sm
  },
  commentThreadGroup: {
    gap: spacing.xs
  },
  commentReplyBlock: {
    marginLeft: spacing.md,
    paddingLeft: spacing.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  commentResolvedBlock: {
    opacity: 0.6
  },
  resolvedCommentSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm
  },
  resolvedCommentTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  commentSource: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    marginBottom: 2
  },
  commentMeta: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  commentControls: {
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  reactionChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  reactionText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  inlineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  actionText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  actionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  setupPromptBox: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs
  },
  setupPromptCommand: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  linearStatesBlock: {
    paddingTop: spacing.sm
  },
  linearStatesTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.xs
  },
  emptyInlineText: {
    color: colors.textSecondary,
    fontSize: 13,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.md
  },
  createForm: {
    gap: spacing.sm
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary
  },
  inlineTextLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  inlineTextLinkText: {
    color: colors.textSecondary,
    fontSize: 12,
    textDecorationLine: 'underline'
  },
  securityHintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  securityHintText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16
  },
  targetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  targetButtonText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  issueSourceBox: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    padding: spacing.sm,
    gap: spacing.xs
  },
  issueSourceHint: {
    fontSize: 12,
    color: colors.textSecondary
  },
  issueSourceSegment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgBase,
    padding: 2,
    gap: 2
  },
  issueSourceSegmentButton: {
    flex: 1,
    borderRadius: radii.input - 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  issueSourceSegmentButtonActive: {
    backgroundColor: colors.bgRaised
  },
  issueSourceSegmentText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted
  },
  issueSourceSegmentTextActive: {
    color: colors.textPrimary
  },
  issueSourceSlug: {
    marginTop: 1,
    fontSize: 10,
    color: colors.textMuted
  },
  drawerLoadingRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  input: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  bodyInput: {
    minHeight: 88
  },
  monoInput: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  commentInput: {
    minHeight: 72,
    marginTop: spacing.sm
  },
  commentComposer: {
    position: 'relative',
    marginTop: spacing.sm
  },
  commentComposerInput: {
    minHeight: 40,
    maxHeight: 120,
    marginTop: 0,
    paddingRight: 44
  },
  commentComposerSend: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  commentComposerSendPressed: {
    opacity: 0.75
  },
  commentComposerSendDisabled: {
    opacity: 0.5
  },
  replyInput: {
    minHeight: 48,
    marginTop: spacing.xs
  },
  stackedInput: {
    marginTop: spacing.sm
  },
  inlineSaveButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  inlineSaveButtonCompact: {
    alignSelf: 'flex-start',
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  inlineSaveText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  inlineButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  drawerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  secondaryActionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.sm
  },
  secondaryActionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  primaryActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm
  },
  primaryActionText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  inlineDeleteText: {
    color: colors.statusRed,
    fontSize: 12,
    fontWeight: '600'
  },
  createButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center'
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
})

function getPrSignalToneStyle(tone: 'neutral' | 'success' | 'warning' | 'danger') {
  if (tone === 'success') {
    return styles.prSignalSuccess
  }
  if (tone === 'warning') {
    return styles.prSignalWarning
  }
  if (tone === 'danger') {
    return styles.prSignalDanger
  }
  return null
}

function getGitLabPipelineStatusStyle(status: string) {
  switch (status) {
    case 'success':
      return styles.pipelineStatusSuccess
    case 'failed':
      return styles.pipelineStatusDanger
    case 'manual':
      return styles.pipelineStatusWarning
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return styles.pipelineStatusActive
    case 'canceled':
    case 'skipped':
    default:
      return null
  }
}
