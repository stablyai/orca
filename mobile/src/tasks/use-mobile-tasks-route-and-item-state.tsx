import type { MobileTasksHostOperations } from './use-mobile-tasks-host-operations'
import {
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  type GitHubRepoSlugCacheEntry,
  type TaskProvider,
  normalizeVisibleTaskProviders,
  useHostRepoList,
  useMobileTaskCopyFeedback,
  useRef,
  useState
} from './mobile-tasks-dependencies'
import {
  type ActionableTaskItem,
  DEFAULT_LINEAR_DISPLAY_PROPERTIES,
  type GitHubPreset,
  type GitHubProjectRow,
  type GitHubRepoSources,
  type GitHubTaskKind,
  type GitLabFilter,
  type GitLabView,
  type LinearDisplayProperty,
  type LinearFilter,
  type LinearGroupBy,
  type LinearOrderBy,
  type LinearTeam,
  type LinearViewMode,
  type LinearWorkspace,
  type PendingHostedMerge,
  type PendingHostedStateChange,
  type PendingProjectGitHubMerge,
  type RepoSummary,
  type TaskItem,
  type TaskResumeState,
  type TaskSort,
  type TasksSupportState,
  getTaskPresetQuery
} from './mobile-tasks-model'
import { useMobileTasksItemState } from './use-mobile-tasks-item-state'

export function useMobileTasksRouteAndItemState(hostOperations: MobileTasksHostOperations) {
  const { connState, deviceOperations, taskReadOperations } = hostOperations
  const loadGenerationRef = useRef(0)
  const taskResumeRef = useRef<TaskResumeState>({})
  const repoList = useHostRepoList<RepoSummary>(
    taskReadOperations,
    taskReadOperations && connState === 'connected'
      ? () => taskReadOperations.listRepositories()
      : null
  )
  const repos = repoList.state.repos
  const { ensureLoaded: repoListEnsureLoaded, reload: repoListReload } = repoList
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
    operations: null
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
  const itemState = useMobileTasksItemState()
  const { copiedLinkResetTimerRef, setCopiedLinkKey } = itemState
  const { copyTaskLink, copyTextToClipboard } = useMobileTaskCopyFeedback({
    operations: deviceOperations,
    resetTimerRef: copiedLinkResetTimerRef,
    setCopiedKey: setCopiedLinkKey,
    setError
  })
  return {
    ...hostOperations,
    actionItem,
    appliedQuery,
    copyTaskLink,
    copyTextToClipboard,
    createBody,
    createRepoId,
    createTeamId,
    createTitle,
    creatingTask,
    defaultGitHubPreset,
    defaultLinearTeamSelectionRef,
    defaultRepoSelectionRef,
    error,
    githubCurrentPage,
    githubKind,
    githubLoadingTargetPage,
    githubMode,
    githubPages,
    githubPaginationLoading,
    githubPreset,
    githubRepoSlugCache,
    githubRepoSources,
    githubSourceErrors,
    githubSourceFallbacks,
    githubTotalCount,
    gitlabFilter,
    gitlabView,
    items,
    linearApiKeyDraft,
    linearConnectError,
    linearConnectState,
    linearConnected,
    linearDisplayProperties,
    linearFilter,
    linearGroupBy,
    linearOrderBy,
    linearTeamPropertyTouched,
    linearTeams,
    linearViewMode,
    linearWorkspaces,
    loadGenerationRef,
    loading,
    mergeMethodProjectRow,
    mergeMethodTaskItem,
    pendingHostedMerge,
    pendingHostedStateChange,
    pendingProjectGitHubMerge,
    provider,
    query,
    refreshing,
    repoList,
    repoListEnsureLoaded,
    repoListReload,
    repoSelectionHydratedRef,
    repos,
    retryingGithubSourceRepoPaths,
    selectedLinearTeamIds,
    selectedLinearWorkspaceId,
    selectedRepoIds,
    setActionItem,
    setAppliedQuery,
    setCreateBody,
    setCreateRepoId,
    setCreateTeamId,
    setCreateTitle,
    setCreatingTask,
    setDefaultGitHubPreset,
    setError,
    setGithubCurrentPage,
    setGithubKind,
    setGithubLoadingTargetPage,
    setGithubMode,
    setGithubPages,
    setGithubPaginationLoading,
    setGithubPreset,
    setGithubRepoSlugCache,
    setGithubRepoSources,
    setGithubSourceErrors,
    setGithubSourceFallbacks,
    setGithubTotalCount,
    setGitlabFilter,
    setGitlabView,
    setItems,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setLinearConnected,
    setLinearDisplayProperties,
    setLinearFilter,
    setLinearGroupBy,
    setLinearOrderBy,
    setLinearTeamPropertyTouched,
    setLinearTeams,
    setLinearViewMode,
    setLinearWorkspaces,
    setLoading,
    setMergeMethodProjectRow,
    setMergeMethodTaskItem,
    setPendingHostedMerge,
    setPendingHostedStateChange,
    setPendingProjectGitHubMerge,
    setProvider,
    setQuery,
    setRefreshing,
    setRetryingGithubSourceRepoPaths,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    setSelectedRepoIds,
    setShowCreateTargetPicker,
    setShowCreateTask,
    setShowGitHubIssueSourcePicker,
    setShowGitHubKindPicker,
    setShowGitHubPagePicker,
    setShowGitHubPresetPicker,
    setShowGitLabFilterPicker,
    setShowGitLabViewPicker,
    setShowLinearConnect,
    setShowLinearDisplayPicker,
    setShowLinearFilterPicker,
    setShowLinearGroupPicker,
    setShowLinearOrderPicker,
    setShowLinearTeamPicker,
    setShowLinearViewPicker,
    setShowLinearWorkspacePicker,
    setShowProviderPicker,
    setShowRepoPicker,
    setShowSortPicker,
    setTaskSort,
    setTasksSupportState,
    setVisibleProviders,
    showCreateTargetPicker,
    showCreateTask,
    showGitHubIssueSourcePicker,
    showGitHubKindPicker,
    showGitHubPagePicker,
    showGitHubPresetPicker,
    showGitLabFilterPicker,
    showGitLabViewPicker,
    showLinearConnect,
    showLinearDisplayPicker,
    showLinearFilterPicker,
    showLinearGroupPicker,
    showLinearOrderPicker,
    showLinearTeamPicker,
    showLinearViewPicker,
    showLinearWorkspacePicker,
    showProviderPicker,
    showRepoPicker,
    showSortPicker,
    taskResumeRef,
    taskSort,
    tasksSupportState,
    visibleProviders,
    ...itemState
  }
}

export type RouteAndItemStateModel = ReturnType<typeof useMobileTasksRouteAndItemState>
