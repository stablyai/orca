import type { WorkspaceAndProjectStateModel } from './use-mobile-tasks-workspace-and-project-state'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  githubProjectHost,
  hasSettledHostRepoList,
  isHostedTaskRepo,
  useCallback,
  useMemo
} from './mobile-tasks-dependencies'
import { groupRows, sortRows } from '../../../src/shared/github/project-group-sort'
import type { ProjectGroup } from '../../../src/shared/github/project-group-sort'
import {
  type GitHubProjectRow,
  type ProjectListEntry,
  type RepoSummary,
  groupDetailComments,
  isTaskProvider,
  normalizeProjectTableForMobileSort,
  projectFieldVisibilityKey,
  projectSummaryFields
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProjectProjection(model: WorkspaceAndProjectStateModel) {
  const {
    actionItem,
    client,
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
    taskSource,
    taskStateHydrated,
    tasksSupportState
  } = model
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
  // Why: `every` is vacuously true on an empty repo list, so readiness has to ask
  // the resource whether that list is real yet. Otherwise the board renders
  // "No project items" for a board whose repos simply have not arrived.
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
    projectDetailCommentGroups,
    requestedTaskSource,
    linearMetadataItem,
    tasksSupported,
    tasksUnsupported,
    taskUiReady,
    activeGitHubProject,
    activeGitHubProjectHost,
    hostedRepos,
    workspaceRepos,
    reposById,
    selectedHostedRepos,
    findProjectRowRepo,
    githubProjectRepoSlugReady,
    visibleGitHubProjectRows,
    visibleGitHubProjectGroups,
    githubProjectListEntries,
    githubProjectAvailableSummaryFields,
    githubProjectFieldVisibilityScope,
    githubProjectHiddenFieldIds,
    githubProjectSummaryFields
  })
}

export type ProjectProjectionModel = ReturnType<typeof useMobileTasksProjectProjection>
