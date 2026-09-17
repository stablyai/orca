import type { RuntimeHydrationModel } from './use-mobile-tasks-runtime-hydration'
import type { RpcSendParams } from '../transport/rpc-params-contract'
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
  mapWithConcurrency,
  reconcileTeamSelection,
  scopeGitHubTaskSearch,
  taskTime
} from './mobile-tasks-legacy-foundation'
import {
  githubWorkItemCountRead,
  linearAccountStatusRead,
  linearWorkspaceTeamListRead
} from './mobile-task-list-operations'
import { githubWorkItemSearchRead } from './mobile-task-source-search-operations'
import { taskSettingsWrite } from './mobile-task-runtime-operations'

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
    const statusReply = await linearAccountStatusRead.request(client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    const status = linearAccountStatusRead.interpret(statusReply) as LinearStatusResponse
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    const teams = linearWorkspaceTeamListRead.interpret(teamsReply) as LinearTeam[]
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
      // Fire-and-forget: the reply is never interpreted, so no acceptance policy applies here.
      void taskSettingsWrite
        .request(client, { defaultLinearTeamSelection: selection })
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
            // `before` is the list's pagination cursor, and github.listWorkItems' params schema
            // does not declare it, so the host has always dropped it. Sent verbatim anyway:
            // removing it would change the bytes, and making the host honour the cursor is a
            // product fix with its own recording, not part of this migration.
            const pageParams = {
              repo: `id:${repo.id}`,
              limit: PER_REPO_FETCH_LIMIT,
              query: scopeGitHubTaskSearch(appliedQuery, githubKind),
              before
            }
            const reply = await githubWorkItemSearchRead.request(
              requestClient,
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `before` is the undeclared key described above; every other field matches the schema.
              pageParams as RpcSendParams<'github.listWorkItems'>
            )
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires `items` and types each row without requiring a member, because the recorded smart-search success carries rows of `{ number, title }`; `sources`/`errors` stay opaque because the two banner extractors below read them member by member with their own guards.
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
            const reply = await githubWorkItemCountRead.request(
              requestClient,
              {
                repo: `id:${repo.id}`,
                query: scopeGitHubTaskSearch(appliedQuery, githubKind)
              },
              { timeoutMs: 30_000 }
            )
            const count = githubWorkItemCountRead.interpret(reply)
            return typeof count === 'number' ? count : 0
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
