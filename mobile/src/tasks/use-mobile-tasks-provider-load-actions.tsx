import type { RuntimeHydrationModel } from './use-mobile-tasks-runtime-hydration'
import { readJiraConnection, reconcileJiraConnection } from './jira-mobile-connection'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  PER_REPO_FETCH_LIMIT,
  type RpcClient,
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback,
  getTaskPagePerRepoLimit,
  getWorkItemCountedTotalPages,
  isGitHubWorkItemsSshRemoteRequiredError,
  taskPageToGitHubApiPage,
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
  scopeGitHubTaskSearch
} from './mobile-tasks-legacy-foundation'
import {
  githubWorkItemCountRead,
  linearAccountStatusRead,
  linearWorkspaceTeamListRead
} from './mobile-task-list-operations'
import { githubWorkItemSearchRead } from './mobile-task-source-search-operations'
import { taskSettingsWrite } from './mobile-task-runtime-operations'

export type ProviderLoadActionsInput = Pick<
  RuntimeHydrationModel,
  | 'appliedQuery'
  | 'client'
  | 'clientRef'
  | 'connState'
  | 'defaultLinearTeamSelectionRef'
  | 'githubKind'
  | 'setJiraConnection'
  | 'jiraStatusRequestIdRef'
  | 'setLinearConnected'
  | 'setLinearTeams'
  | 'setLinearWorkspaces'
  | 'setSelectedLinearTeamIds'
  | 'setSelectedLinearWorkspaceId'
  | 'taskUiReady'
  | 'tasksSupported'
>

export function useMobileTasksProviderLoadActions<Model extends ProviderLoadActionsInput>(
  model: Model
) {
  const {
    appliedQuery,
    client,
    clientRef,
    connState,
    defaultLinearTeamSelectionRef,
    githubKind,
    setJiraConnection,
    jiraStatusRequestIdRef,
    setLinearConnected,
    setLinearTeams,
    setLinearWorkspaces,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    taskUiReady,
    tasksSupported
  } = model
  // Mobile needs explicit status refreshes to observe desktop connection changes.
  const refreshJiraConnection = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    const requestId = ++jiraStatusRequestIdRef.current
    const next = await readJiraConnection(client)
    if (clientRef.current === client && jiraStatusRequestIdRef.current === requestId) {
      setJiraConnection((current) => reconcileJiraConnection(current, next))
    }
  }, [client, clientRef, connState, tasksSupported, setJiraConnection, jiraStatusRequestIdRef])

  const loadLinearContext = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    const statusReply = await linearAccountStatusRead.request(client)
    const status = linearAccountStatusRead.interpret(statusReply)
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

    const teamsReply = await linearWorkspaceTeamListRead.request(client, {
      workspaceId: workspaceId ?? undefined
    })
    const teams = linearWorkspaceTeamListRead.interpret(teamsReply)
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
      void taskSettingsWrite
        .request(client, { defaultLinearTeamSelection: selection })
        .catch(() => {
          // Preference persistence is best-effort; the local picker already changed.
        })
    },
    [client, taskUiReady]
  )

  const fetchGitHubItemsPage = useCallback(
    async (
      requestClient: RpcClient,
      queriedRepos: RepoSummary[],
      taskPage = 0,
      isCurrent: () => boolean = () => true
    ): Promise<{
      items: Array<Extract<TaskItem, { provider: 'github' }>>
      failedCount: number
      sourcesByRepoId: Record<string, GitHubRepoSources>
      sourceErrors: GitHubIssueSourceError[]
      sourceFallbacks: GitHubIssueSourceFallback[]
    }> => {
      const perRepoLimit = getTaskPagePerRepoLimit(
        queriedRepos.length,
        PER_REPO_FETCH_LIMIT,
        CROSS_REPO_DISPLAY_LIMIT
      )
      const results = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          if (!isCurrent()) {
            return { items: [], repoId: repo.id }
          }
          try {
            const reply = await githubWorkItemSearchRead.request(requestClient, {
              repo: `id:${repo.id}`,
              limit: perRepoLimit,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind),
              page: taskPageToGitHubApiPage(taskPage)
            })
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires `items` and each row's `labels`, and types the other eight (`id`, `type`, `number`, `title`, `state`, `url`, `updatedAt`, `author`). Two gaps keep the cast: the salvaged members type as `T | undefined` where GitHubWorkItem declares them required, and `sources`/`errors`/`issueSourceFellBack` are deliberately `z.unknown()` because the two banner extractors below read them member by member with their own guards.
            const envelope = githubWorkItemSearchRead.interpret(reply) as {
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
        // Host pagination orders by issue number; merge in that order so rows cannot reshuffle between pages.
        items: results
          .flatMap((result) => result.items)
          .sort((a, b) => b.source.number - a.source.number),
        failedCount: results.filter((result) => result.error).length,
        sourcesByRepoId,
        sourceErrors,
        sourceFallbacks
      }
    },
    [appliedQuery, githubKind]
  )

  const countGitHubItemPages = useCallback(
    async (
      requestClient: RpcClient,
      queriedRepos: RepoSummary[],
      isCurrent: () => boolean = () => true
    ): Promise<number> => {
      const counts = await mapWithConcurrency(
        queriedRepos,
        GITHUB_REPO_CONCURRENCY,
        async (repo) => {
          if (!isCurrent()) {
            return 0
          }
          try {
            const reply = await githubWorkItemCountRead.request(
              requestClient,
              {
                repo: `id:${repo.id}`,
                query: scopeGitHubTaskSearch(appliedQuery, githubKind)
              },
              { timeoutMs: 30_000 }
            )
            return githubWorkItemCountRead.interpret(reply)
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
      return getWorkItemCountedTotalPages(
        counts,
        getTaskPagePerRepoLimit(queriedRepos.length, PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT)
      )
    },
    [appliedQuery, githubKind]
  )
  return Object.assign(model, {
    refreshJiraConnection,
    loadLinearContext,
    persistLinearTeamSelection,
    fetchGitHubItemsPage,
    countGitHubItemPages
  })
}

export type ProviderLoadActionsModel = ReturnType<
  typeof useMobileTasksProviderLoadActions<RuntimeHydrationModel>
>
