import type { WorkspaceAndProjectStateModel } from './use-mobile-tasks-workspace-and-project-state'
import {
  type ProjectGroup,
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  githubProjectHost,
  groupRows,
  hasSettledHostRepoList,
  isHostedTaskRepo,
  sortRows,
  useCallback,
  useMemo
} from './mobile-tasks-dependencies'
import {
  type GitHubProjectRow,
  type ProjectListEntry,
  type RepoSummary,
  groupDetailComments,
  isTaskProvider,
  normalizeProjectTableForMobileSort,
  projectFieldVisibilityKey,
  projectSummaryFields
} from './mobile-tasks-model'

export function useMobileTasksProjectProjection(model: WorkspaceAndProjectStateModel) {
  const {
    actionItem,
    collapsedGitHubProjectGroups,
    connState,
    githubProjectHiddenFieldIdsByView,
    githubProjectSettings,
    githubProjectSortOverride,
    githubProjectTable,
    githubRepoSlugCache,
    linearStatusPickerItem,
    projectRowDetail,
    repoList,
    repos,
    selectedRepoIds,
    taskReadOperations,
    taskSource,
    taskStateHydrated,
    tasksSupportState
  } = model
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
    taskReadOperations != null &&
    tasksSupportState.kind === 'supported' &&
    tasksSupportState.operations === taskReadOperations
  const tasksUnsupported =
    connState === 'connected' &&
    taskReadOperations != null &&
    tasksSupportState.kind === 'unsupported' &&
    tasksSupportState.operations === taskReadOperations
  const taskUiReady = tasksSupported && taskStateHydrated
  const activeGitHubProject = githubProjectSettings.activeProject
  const activeGitHubProjectHost = githubProjectHost(
    githubProjectTable?.project.host ?? activeGitHubProject?.host
  )
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
        githubRepoSlugCache,
        activeGitHubProjectHost
      ) as RepoSummary | null,
    [activeGitHubProjectHost, githubRepoSlugCache, hostedRepos]
  )
  const githubProjectRepoSlugReady = useMemo(
    () =>
      hasSettledHostRepoList(repoList.state) &&
      hostedRepos.every((repo) => {
        const cached = githubRepoSlugCache[repo.id]
        return cached !== undefined && cached.path === repo.path
      }),
    [githubRepoSlugCache, hostedRepos, repoList.state]
  )
  const visibleGitHubProjectRows = useMemo(
    () =>
      githubProjectTable
        ? (filterGitHubProjectRowsForRepos(
            githubProjectTable.rows,
            hostedRepos,
            githubRepoSlugCache,
            activeGitHubProjectHost
          ) as GitHubProjectRow[])
        : [],
    [activeGitHubProjectHost, githubProjectTable, githubRepoSlugCache, hostedRepos]
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
  return Object.assign(model, {
    activeGitHubProject,
    activeGitHubProjectHost,
    findProjectRowRepo,
    githubProjectAvailableSummaryFields,
    githubProjectFieldVisibilityScope,
    githubProjectHiddenFieldIds,
    githubProjectListEntries,
    githubProjectRepoSlugReady,
    githubProjectSummaryFields,
    hostedRepos,
    linearMetadataItem,
    projectDetailCommentGroups,
    reposById,
    requestedTaskSource,
    selectedHostedRepos,
    taskUiReady,
    tasksSupported,
    tasksUnsupported,
    visibleGitHubProjectGroups,
    visibleGitHubProjectRows,
    workspaceRepos
  })
}

export type ProjectProjectionModel = ReturnType<typeof useMobileTasksProjectProjection>
