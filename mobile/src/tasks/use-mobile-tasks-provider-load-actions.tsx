import type { HostTaskListOperations } from './host-task-list-operations'
import type { RuntimeHydrationModel } from './use-mobile-tasks-runtime-hydration'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  PER_REPO_FETCH_LIMIT,
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback,
  isGitHubWorkItemsSshRemoteRequiredError,
  useCallback
} from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  type GitHubRepoSources,
  type LinearTeam,
  type RepoSummary,
  type TaskItem,
  createGitHubTask,
  mapWithConcurrency,
  reconcileTeamSelection,
  scopeGitHubTaskSearch,
  taskTime
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProviderLoadActions(model: RuntimeHydrationModel) {
  const {
    appliedQuery,
    connState,
    defaultLinearTeamSelectionRef,
    githubKind,
    setLinearConnected,
    setLinearTeams,
    setLinearWorkspaces,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    taskOperations,
    taskUiReady,
    tasksSupported
  } = model
  const loadLinearContext = useCallback(async (): Promise<void> => {
    if (!taskOperations || connState !== 'connected' || !tasksSupported) {
      return
    }
    const status = await taskOperations.read.linearStatus()
    setLinearConnected(status.connected)
    if (!status.connected) {
      setLinearWorkspaces([])
      setLinearTeams([])
      setSelectedLinearTeamIds(new Set())
      setSelectedLinearWorkspaceId(null)
      return
    }
    const workspaceId =
      status.selectedWorkspaceId ?? status.activeWorkspaceId ?? status.workspaces[0]?.id ?? null
    // Committed before the team read: a failed team read must leave the picker populated and the
    // workspace resolved, or the next list request goes out with no workspace at all.
    setLinearWorkspaces(status.workspaces)
    setSelectedLinearWorkspaceId(workspaceId)
    const teams = await taskOperations.read.linearTeams(workspaceId)
    setLinearTeams(teams)
    setSelectedLinearTeamIds(reconcileTeamSelection(teams, defaultLinearTeamSelectionRef.current))
  }, [connState, taskOperations, tasksSupported])

  const persistLinearTeamSelection = useCallback(
    (teamIds: Set<string>, allTeams: LinearTeam[]) => {
      if (!taskOperations || !taskUiReady) {
        return
      }
      const selection = teamIds.size === allTeams.length ? null : [...teamIds]
      defaultLinearTeamSelectionRef.current = selection
      void taskOperations.preference
        .updateSettings({ defaultLinearTeamSelection: selection })
        .catch(() => {
          // Best-effort preference persistence; the local picker state already changed.
        })
    },
    [taskOperations, taskUiReady]
  )

  const fetchGitHubItemsPage = useCallback(
    async (
      listOperations: HostTaskListOperations,
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
            const envelope = await listOperations.listGitHub({
              repoId: repo.id,
              limit: PER_REPO_FETCH_LIMIT,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind),
              before
            })
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
    async (
      listOperations: HostTaskListOperations,
      queriedRepos: RepoSummary[]
    ): Promise<number> => {
      const counts = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          try {
            // Awaited inside the try on purpose: returning the promise would let a per-repo
            // rejection escape this catch, reject the whole batch and reach a caller with no
            // handler. A failed count is a zero, not a failed load.
            return await listOperations.countGitHub({
              repoId: repo.id,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind)
            })
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
  return Object.assign(model, {
    loadLinearContext,
    persistLinearTeamSelection,
    fetchGitHubItemsPage,
    countGitHubItems
  })
}

export type ProviderLoadActionsModel = ReturnType<typeof useMobileTasksProviderLoadActions>
