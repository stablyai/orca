import type { RuntimeHydrationModel } from './use-mobile-tasks-runtime-hydration'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  PER_REPO_FETCH_LIMIT,
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback,
  isGitHubWorkItemsSshRemoteRequiredError,
  mobileLogErrorKind,
  useCallback
} from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  type GitHubRepoSources,
  type GitHubWorkItem,
  type LinearTeam,
  type RepoSummary,
  type TaskItem,
  createGitHubTask,
  mapWithConcurrency,
  reconcileTeamSelection,
  scopeGitHubTaskSearch,
  taskTime
} from './mobile-tasks-model'

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
    taskListOperations,
    taskPreferenceOperations,
    taskReadOperations,
    taskUiReady,
    tasksSupported
  } = model
  const loadLinearContext = useCallback(async (): Promise<void> => {
    if (!taskReadOperations || connState !== 'connected' || !tasksSupported) {
      return
    }
    const context = await taskReadOperations.loadLinearContext()
    setLinearConnected(context.status.connected)
    if (!context.status.connected) {
      setLinearWorkspaces([])
      setLinearTeams([])
      setSelectedLinearTeamIds(new Set())
      setSelectedLinearWorkspaceId(null)
      return
    }
    const workspaces = context.status.workspaces
    const workspaceId = context.status.selectedWorkspaceId
    setLinearWorkspaces(workspaces)
    setSelectedLinearWorkspaceId(workspaceId)
    const teams = context.teams
    setLinearTeams(teams)
    setSelectedLinearTeamIds(reconcileTeamSelection(teams, defaultLinearTeamSelectionRef.current))
  }, [connState, taskReadOperations, tasksSupported])
  const persistLinearTeamSelection = useCallback(
    (teamIds: Set<string>, allTeams: LinearTeam[]) => {
      if (!taskPreferenceOperations || !taskUiReady) {
        return
      }
      const selection = teamIds.size === allTeams.length ? null : [...teamIds]
      defaultLinearTeamSelectionRef.current = selection
      void taskPreferenceOperations
        .updateSettings({ defaultLinearTeamSelection: selection })
        .catch(() => {
          // Best-effort preference persistence; the local picker state already changed.
        })
    },
    [taskPreferenceOperations, taskUiReady]
  )
  const fetchGitHubItemsPage = useCallback(
    async (
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
            if (!taskListOperations) {
              throw new Error('Task list operations are unavailable')
            }
            const envelope = await taskListOperations.listGitHub({
              repoId: repo.id,
              limit: PER_REPO_FETCH_LIMIT,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind),
              before
            })
            return {
              items: envelope.items.map((item) =>
                createGitHubTask(repo, item as Omit<GitHubWorkItem, 'repoId' | 'repoName'>)
              ),
              sources: envelope.sources
                ? {
                    issues: envelope.sources.issues,
                    prs: envelope.sources.prs ?? null,
                    upstreamCandidate: envelope.sources.upstreamCandidate ?? null
                  }
                : undefined,
              sourceError: extractGitHubIssueSourceError(repo, envelope),
              sourceFallback: extractGitHubIssueSourceFallback(repo, envelope),
              repoId: repo.id
            }
          } catch (err) {
            const isExpectedSshSkip = isGitHubWorkItemsSshRemoteRequiredError(err)
            const logWorkItemFetchFailure = isExpectedSshSkip ? console.log : console.warn
            logWorkItemFetchFailure('[mobile tasks] failed to fetch github work items', {
              expected: isExpectedSshSkip,
              kind: mobileLogErrorKind(err)
            })
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
    [appliedQuery, githubKind, taskListOperations]
  )
  const countGitHubItems = useCallback(
    async (queriedRepos: RepoSummary[]): Promise<number> => {
      const counts = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          try {
            if (!taskListOperations) {
              return 0
            }
            return taskListOperations.countGitHub({
              repoId: repo.id,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind)
            })
          } catch (err) {
            const isExpectedSshSkip = isGitHubWorkItemsSshRemoteRequiredError(err)
            const logWorkItemCountFailure = isExpectedSshSkip ? console.log : console.warn
            logWorkItemCountFailure('[mobile tasks] failed to count github work items', {
              expected: isExpectedSshSkip,
              kind: mobileLogErrorKind(err)
            })
            return 0
          }
        }
      )
      return counts.reduce((sum, count) => sum + count, 0)
    },
    [appliedQuery, githubKind, taskListOperations]
  )
  return Object.assign(model, {
    countGitHubItems,
    fetchGitHubItemsPage,
    loadLinearContext,
    persistLinearTeamSelection
  })
}

export type ProviderLoadActionsModel = ReturnType<typeof useMobileTasksProviderLoadActions>
