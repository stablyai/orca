import {
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  type GitHubRepoSlugCacheEntry,
  type RpcClient,
  type TaskProvider,
  normalizeVisibleTaskProviders,
  useHostClient,
  useHostRepoList,
  useLastConnectedAt,
  useRelayRecoveryStatus,
  useLocalSearchParams,
  useReconnectAttempt,
  useRef,
  useRouter,
  useSafeAreaInsets,
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
  getTaskPresetQuery,
  isSuccess
} from './mobile-tasks-legacy-foundation'
import { useMobileTasksItemState } from './use-mobile-tasks-item-state'

export function useMobileTasksRouteAndItemState() {
  const { hostId, taskSource } = useLocalSearchParams<{ hostId: string; taskSource?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const relayRecovery = useRelayRecoveryStatus(hostId)
  const clientRef = useRef<RpcClient | null>(null)
  const loadGenerationRef = useRef(0)
  const taskResumeRef = useRef<TaskResumeState>({})
  const repoList = useHostRepoList<RepoSummary>(
    client,
    client && connState === 'connected'
      ? async () => {
          const response = await client.sendRequest('repo.list')
          if (!isSuccess(response)) {
            throw new Error(response.error.message)
          }
          return (response.result as { repos: RepoSummary[] }).repos
        }
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
  const itemState = useMobileTasksItemState()
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
    repoListEnsureLoaded,
    repoListReload,
    provider,
    setProvider,
    visibleProviders,
    setVisibleProviders,
    linearConnected,
    setLinearConnected,
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
    defaultRepoSelectionRef,
    repoSelectionHydratedRef,
    defaultLinearTeamSelectionRef,
    showLinearWorkspacePicker,
    setShowLinearWorkspacePicker,
    showLinearTeamPicker,
    setShowLinearTeamPicker,
    showLinearViewPicker,
    setShowLinearViewPicker,
    showLinearGroupPicker,
    setShowLinearGroupPicker,
    showLinearOrderPicker,
    setShowLinearOrderPicker,
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
    setSelectedRepoIds,
    items,
    setItems,
    githubPages,
    setGithubPages,
    githubCurrentPage,
    setGithubCurrentPage,
    githubTotalCount,
    setGithubTotalCount,
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
    showProviderPicker,
    setShowProviderPicker,
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
    showSortPicker,
    setShowSortPicker,
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
    refreshing,
    setRefreshing,
    tasksSupportState,
    setTasksSupportState,
    error,
    setError,
    actionItem,
    setActionItem,
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
    ...itemState
  }
}

export type RouteAndItemStateModel = ReturnType<typeof useMobileTasksRouteAndItemState>
