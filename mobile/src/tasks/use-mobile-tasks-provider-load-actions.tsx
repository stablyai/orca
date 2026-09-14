import type { RuntimeHydrationModel } from './use-mobile-tasks-runtime-hydration'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  PER_REPO_FETCH_LIMIT,
  type RpcClient,
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback,
  isGitHubWorkItemsSshRemoteRequiredError,
  useCallback
} from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  type GitHubRepoSources,
  type GitHubWorkItem,
  type LinearStatusResponse,
  type LinearTeam,
  type RepoSummary,
  type TaskItem,
  createGitHubTask,
  isSuccess,
  mapWithConcurrency,
  reconcileTeamSelection,
  scopeGitHubTaskSearch,
  taskTime
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProviderLoadActions(model: RuntimeHydrationModel) {
  const {
    appliedQuery,
    client,
    connState,
    defaultLinearTeamSelectionRef,
    githubKind,
    setLinearConnected,
    setLinearTeams,
    setLinearWorkspaces,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    taskUiReady,
    tasksSupported
  } = model
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
  return Object.assign(model, {
    loadLinearContext,
    persistLinearTeamSelection,
    fetchGitHubItemsPage,
    countGitHubItems
  })
}

export type ProviderLoadActionsModel = ReturnType<typeof useMobileTasksProviderLoadActions>
