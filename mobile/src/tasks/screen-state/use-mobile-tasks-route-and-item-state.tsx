import { useMobileTasksSelection } from '../item-detail/github-task-identity'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type {
  GitHubIssueSourceError,
  GitHubIssueSourceFallback
} from '../hosted-review/github-work-item-source-errors'
import type { GitHubRepoSlugCacheEntry } from '../project-board/github-project-repo-match'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { useHostRepoList } from '../repositories/use-host-repo-list'
import { useMemo, useRef, useState } from 'react'
import { reconcileRepoSelection } from '../repositories/hosted-repo-selection'
import {
  useLastConnectedAt,
  useRelayRecoveryStatus,
  useReconnectAttempt
} from '../../transport/connection/client-context-connection-metrics'
import { useLocalSearchParams } from 'expo-router'
import { useRouteHandoff as useRouter } from '../../navigation/route-handoff'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  type TaskProvider,
  normalizeVisibleTaskProviders
} from '../../../../src/shared/work-items/task-providers'
import { newTabRepoListRead } from '../../session/agent-launch/mobile-runtime-repo-operations'
import { useHostProtocolGates } from '../../components/host-protocol-gates-context'
import { useTaskHostRepos } from '../repositories/use-task-host-repos'
import { DEFAULT_LINEAR_DISPLAY_PROPERTIES } from '../task-list/mobile-tasks-options'
import type {
  GitHubPreset,
  GitHubProjectRow,
  GitHubTaskKind,
  GitLabFilter,
  GitLabView,
  LinearDisplayProperty,
  LinearFilter,
  LinearGroupBy,
  LinearOrderBy,
  LinearViewMode,
  LinearWorkspace,
  TaskResumeState,
  TaskSort
} from '../mobile-tasks-view-state-types'
import type {
  GitHubRepoSources,
  LinearTeam,
  RepoSummary,
  TasksSupportState
} from '../mobile-tasks-provider-detail-types'
import type {
  PendingHostedMerge,
  PendingHostedStateChange,
  PendingProjectGitHubMerge,
  TaskItem
} from '../mobile-tasks-project-workspace-types'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'
import { useMobileTasksItemState } from '../item-detail/use-mobile-tasks-item-state'
import { useTaskCommentDraft, useTaskCreateDraft } from '../item-detail/task-draft-rows'
import { useMobileJiraConnectionState } from '../providers/jira/use-mobile-jira-connection-state'
import type { JiraIssueFilter } from '../../../../src/shared/jira/jira-types'

export function useMobileTasksRouteAndItemState() {
  const { hostId, taskSource } = useLocalSearchParams<{ hostId: string; taskSource?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client: desktopClient, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const clientRef = useRef<RpcClient | null>(null)
  const loadGenerationRef = useRef(0)
  const taskResumeRef = useRef<TaskResumeState>({})
  const repoList = useHostRepoList<RepoSummary>(
    desktopClient,
    desktopClient && connState === 'connected'
      ? async () => {
          const reply = await newTabRepoListRead.request(desktopClient)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          return newTabRepoListRead.interpret(reply) as RepoSummary[]
        }
      : null
  )
  // One routed client sends each server repo’s calls to its owner.
  const { client, repos, serverRepoList, repoListEnsureLoaded, repoListReload, repoHostLabels } =
    useTaskHostRepos({
      hostId,
      desktopClient,
      connState,
      hostCapabilities,
      desktopRepoList: repoList
    })
  const [provider, setProvider] = useState<TaskProvider>('github')
  const [visibleProviders, setVisibleProviders] = useState<TaskProvider[]>(() =>
    normalizeVisibleTaskProviders(undefined)
  )
  const [linearConnected, setLinearConnected] = useState(false)
  const [jiraConnection, setJiraConnection] = useMobileJiraConnectionState(client, connState)
  const jiraStatusRequestIdRef = useRef(0)
  const [jiraFilter, setJiraFilter] = useState<JiraIssueFilter>('assigned')
  const [showJiraFilterPicker, setShowJiraFilterPicker] = useState(false)
  const [showJiraSitePicker, setShowJiraSitePicker] = useState(false)
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
  const defaultLinearTeamSelectionRef = useRef<string[] | null>(null)
  const [showLinearWorkspacePicker, setShowLinearWorkspacePicker] = useState(false)
  const [showLinearTeamPicker, setShowLinearTeamPicker] = useState(false)
  const [showLinearDisplayPicker, setShowLinearDisplayPicker] = useState(false)
  const [showLinearConnect, setShowLinearConnect] = useState(false)
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState('')
  const [linearConnectState, setLinearConnectState] = useState<'idle' | 'connecting' | 'error'>(
    'idle'
  )
  const [linearConnectError, setLinearConnectError] = useState('')
  const [taskSort, setTaskSort] = useState<TaskSort>('updated')
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set())
  // Readers narrow saved ids without pruning; only user edits may drop temporarily absent server repos.
  const effectiveRepoKey = [...reconcileRepoSelection(repos, [...selectedRepoIds])]
    .sort()
    .join('\n')
  const effectiveRepoIds = useMemo(
    (): ReadonlySet<string> => new Set(effectiveRepoKey ? effectiveRepoKey.split('\n') : []),
    [effectiveRepoKey]
  )
  const [items, setItems] = useState<TaskItem[]>([])
  const [githubPages, setGithubPages] = useState<
    Array<Extract<TaskItem, { provider: 'github' }>[]>
  >([])
  const [githubCurrentPage, setGithubCurrentPage] = useState(0)
  const [githubCountedTotalPages, setGithubCountedTotalPages] = useState<number | null>(null)
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
  const [showGitHubKindPicker, setShowGitHubKindPicker] = useState(false)
  const [showGitHubPresetPicker, setShowGitHubPresetPicker] = useState(false)
  const [showGitLabViewPicker, setShowGitLabViewPicker] = useState(false)
  const [showGitLabFilterPicker, setShowGitLabFilterPicker] = useState(false)
  const [showLinearFilterPicker, setShowLinearFilterPicker] = useState(false)
  const [showFilterSheet, setShowFilterSheet] = useState(false)
  const [showRepoPicker, setShowRepoPicker] = useState(false)
  const [showGitHubIssueSourcePicker, setShowGitHubIssueSourcePicker] = useState(false)
  const [showGitHubPagePicker, setShowGitHubPagePicker] = useState(false)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showCreateTargetPicker, setShowCreateTargetPicker] = useState(false)
  const { createTitle, setCreateTitle, createBody, setCreateBody } =
    useTaskCreateDraft(showCreateTask)
  const [createRepoId, setCreateRepoId] = useState<string | null>(null)
  const [createTeamId, setCreateTeamId] = useState<string | null>(null)
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([])
  const [creatingTask, setCreatingTask] = useState(false)
  const [loading, setLoading] = useState(false)
  // False until a list read settles, so an unread list is not shown as an empty one.
  const [taskListSettled, setTaskListSettled] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [tasksSupportState, setTasksSupportState] = useState<TasksSupportState>({
    kind: 'unknown',
    client: null
  })
  const [error, setError] = useState('')
  const itemState = useMobileTasksItemState()
  const itemSelection = useMobileTasksSelection(
    client,
    itemState.readDetailPayload,
    itemState.reconcilePrFileConnection
  )
  const [itemCommentDraft, setItemCommentDraft] = useTaskCommentDraft(itemSelection.actionItem)
  const [mergeMethodTaskItem, setMergeMethodTaskItem] = useState<
    Extract<TaskItem, { provider: 'github' }> | Extract<TaskItem, { provider: 'gitlab' }> | null
  >(null)
  const [mergeMethodProjectRow, setMergeMethodProjectRow] = useState<GitHubProjectRow | null>(null)
  const [pendingHostedMerge, setPendingHostedMerge] = useState<PendingHostedMerge | null>(null)
  const [pendingProjectGitHubMerge, setPendingProjectGitHubMerge] =
    useState<PendingProjectGitHubMerge | null>(null)
  const [pendingHostedStateChange, setPendingHostedStateChange] =
    useState<PendingHostedStateChange | null>(null)
  return {
    hostId,
    taskSource,
    router,
    insets,
    client,
    connState,
    reconnectAttempts,
    lastConnectedAt,
    relayRecovery,
    clientRef,
    loadGenerationRef,
    taskResumeRef,
    repoList,
    repos,
    serverRepoList,
    repoHostLabels,
    repoListEnsureLoaded,
    repoListReload,
    provider,
    setProvider,
    visibleProviders,
    setVisibleProviders,
    linearConnected,
    setLinearConnected,
    jiraConnection,
    setJiraConnection,
    jiraStatusRequestIdRef,
    jiraFilter,
    setJiraFilter,
    showJiraFilterPicker,
    setShowJiraFilterPicker,
    showJiraSitePicker,
    setShowJiraSitePicker,
    githubMode,
    setGithubMode,
    githubKind,
    setGithubKind,
    githubPreset,
    setGithubPreset,
    defaultGitHubPreset,
    setDefaultGitHubPreset,
    gitlabView,
    setGitlabView,
    gitlabFilter,
    setGitlabFilter,
    linearFilter,
    setLinearFilter,
    linearViewMode,
    setLinearViewMode,
    linearGroupBy,
    setLinearGroupBy,
    linearOrderBy,
    setLinearOrderBy,
    linearDisplayProperties,
    setLinearDisplayProperties,
    linearTeamPropertyTouched,
    setLinearTeamPropertyTouched,
    linearWorkspaces,
    setLinearWorkspaces,
    selectedLinearWorkspaceId,
    setSelectedLinearWorkspaceId,
    selectedLinearTeamIds,
    setSelectedLinearTeamIds,
    defaultLinearTeamSelectionRef,
    showLinearWorkspacePicker,
    setShowLinearWorkspacePicker,
    showLinearTeamPicker,
    setShowLinearTeamPicker,
    showLinearDisplayPicker,
    setShowLinearDisplayPicker,
    showLinearConnect,
    setShowLinearConnect,
    linearApiKeyDraft,
    setLinearApiKeyDraft,
    linearConnectState,
    setLinearConnectState,
    linearConnectError,
    setLinearConnectError,
    taskSort,
    setTaskSort,
    selectedRepoIds,
    effectiveRepoIds,
    setSelectedRepoIds,
    items,
    setItems,
    githubPages,
    setGithubPages,
    githubCurrentPage,
    setGithubCurrentPage,
    githubCountedTotalPages,
    setGithubCountedTotalPages,
    githubPaginationLoading,
    setGithubPaginationLoading,
    githubLoadingTargetPage,
    setGithubLoadingTargetPage,
    githubRepoSources,
    setGithubRepoSources,
    githubSourceErrors,
    setGithubSourceErrors,
    githubSourceFallbacks,
    setGithubSourceFallbacks,
    retryingGithubSourceRepoPaths,
    setRetryingGithubSourceRepoPaths,
    githubRepoSlugCache,
    setGithubRepoSlugCache,
    query,
    setQuery,
    appliedQuery,
    setAppliedQuery,
    showGitHubKindPicker,
    setShowGitHubKindPicker,
    showGitHubPresetPicker,
    setShowGitHubPresetPicker,
    showGitLabViewPicker,
    setShowGitLabViewPicker,
    showGitLabFilterPicker,
    setShowGitLabFilterPicker,
    showLinearFilterPicker,
    setShowLinearFilterPicker,
    showFilterSheet,
    setShowFilterSheet,
    showRepoPicker,
    setShowRepoPicker,
    showGitHubIssueSourcePicker,
    setShowGitHubIssueSourcePicker,
    showGitHubPagePicker,
    setShowGitHubPagePicker,
    showCreateTask,
    setShowCreateTask,
    showCreateTargetPicker,
    setShowCreateTargetPicker,
    createTitle,
    setCreateTitle,
    createBody,
    setCreateBody,
    createRepoId,
    setCreateRepoId,
    createTeamId,
    setCreateTeamId,
    linearTeams,
    setLinearTeams,
    creatingTask,
    setCreatingTask,
    loading,
    setLoading,
    taskListSettled,
    setTaskListSettled,
    refreshing,
    setRefreshing,
    tasksSupportState,
    setTasksSupportState,
    error,
    setError,
    ...itemSelection,
    mergeMethodTaskItem,
    setMergeMethodTaskItem,
    mergeMethodProjectRow,
    setMergeMethodProjectRow,
    pendingHostedMerge,
    setPendingHostedMerge,
    pendingProjectGitHubMerge,
    setPendingProjectGitHubMerge,
    pendingHostedStateChange,
    setPendingHostedStateChange,
    ...itemState,
    itemCommentDraft,
    setItemCommentDraft
  }
}

export type RouteAndItemStateModel = ReturnType<typeof useMobileTasksRouteAndItemState>
