import type { ClassifiedError } from '../../../../src/shared/errors/classified-error'
import { getWorkItemPageErrorTypes } from '../../../../src/shared/github/work-items/work-item-page-errors'
import type { RuntimeHydrationModel } from '../screen-state/use-mobile-tasks-runtime-hydration'
import {
  readJiraConnection,
  reconcileJiraConnection
} from '../providers/jira/jira-mobile-connection'
import {
  JiraConnectRefusedError,
  jiraAccountConnect
} from '../providers/jira/mobile-jira-operations'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  PER_REPO_FETCH_LIMIT,
  getTaskPagePerRepoLimit,
  getWorkItemCountedTotalPages,
  taskPageToGitHubApiPage
} from '../../../../src/shared/work-items/work-item-pagination'
import { isGitHubWorkItemsSshRemoteRequiredError } from '../../../../src/shared/github/work-items/work-item-ssh-error'
import {
  type GitHubIssueSourceError,
  type GitHubIssueSourceFallback,
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from '../hosted-review/github-work-item-source-errors'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useCallback } from 'react'
import { GITHUB_REPO_CONCURRENCY } from './mobile-tasks-options'
import type {
  GitHubRepoSources,
  GitHubWorkItem,
  LinearTeam,
  RepoSummary
} from '../mobile-tasks-provider-detail-types'
import type { TaskItem } from '../mobile-tasks-project-workspace-types'
import { createGitHubTask, mapWithConcurrency } from '../item-detail/mobile-tasks-item-mapping'
import { reconcileTeamSelection } from '../item-detail/mobile-tasks-reviewer-linear'
import { scopeGitHubTaskSearch } from '../../../../src/shared/work-items/task-github-search'
import { sortWorkItemsByRecency } from '../../../../src/shared/work-items/work-item-order'
import {
  githubWorkItemCountRead,
  linearAccountStatusRead,
  linearWorkspaceTeamListRead
} from './mobile-task-list-operations'
import { githubWorkItemSearchRead } from '../providers/mobile-task-source-search-operations'
import { trackerAccountClient } from './tracker-account-host'
import { taskSettingsWrite } from '../screen-state/mobile-task-runtime-operations'

export type ProviderLoadActionsInput = Pick<
  RuntimeHydrationModel,
  | 'appliedQuery'
  | 'client'
  | 'clientRef'
  | 'connState'
  | 'defaultLinearTeamSelectionRef'
  | 'githubKind'
  | 'keepSettings'
  | 'linearAccountBindingRef'
  | 'jiraAccountBindingRef'
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
    keepSettings,
    linearAccountBindingRef,
    jiraAccountBindingRef,
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
  // Untagged like the issue lists, so both follow the same host; only a fresh connect reads its own.
  const refreshJiraConnection = useCallback(
    async (statusClient?: RpcClient): Promise<void> => {
      if (!client || connState !== 'connected' || !tasksSupported) {
        return
      }
      const requestId = ++jiraStatusRequestIdRef.current
      const next = await readJiraConnection(statusClient ?? client)
      if (clientRef.current === client && jiraStatusRequestIdRef.current === requestId) {
        setJiraConnection((current) => reconcileJiraConnection(current, next))
      }
    },
    [client, clientRef, connState, tasksSupported, setJiraConnection, jiraStatusRequestIdRef]
  )

  // Throws the host's message (bad token, bad site URL) for the setup sheet to show.
  const connectJiraAccount = useCallback(
    async (args: { siteUrl: string; email: string; apiToken: string }): Promise<void> => {
      if (!client || connState !== 'connected') {
        throw new Error('Not connected to this host')
      }
      const target = await trackerAccountClient(jiraAccountBindingRef.current, client)
      const reply = await jiraAccountConnect.request(target, { ...args, authType: 'cloud' })
      // An older tracker server refuses phone setup even when this desktop allows it.
      if (!reply.ok && reply.error.code === 'forbidden') {
        throw new JiraConnectRefusedError()
      }
      const result = jiraAccountConnect.interpret(reply)
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to connect Jira')
      }
      // A failed status read keeps the sheet open with its error; Connect again re-saves the same site.
      await refreshJiraConnection(target)
    },
    [client, connState, refreshJiraConnection]
  )

  const loadLinearContext = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !tasksSupported) {
      return
    }
    const statusReply = await linearAccountStatusRead.request(
      await trackerAccountClient(linearAccountBindingRef.current, client)
    )
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
      keepSettings({ defaultLinearTeamSelection: selection })
      void taskSettingsWrite
        .request(client, { defaultLinearTeamSelection: selection })
        .catch(() => {
          // Preference persistence is best-effort; the local picker already changed.
        })
    },
    [client, keepSettings, taskUiReady]
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
      errorTypes: ClassifiedError['type'][]
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
            const decoded = githubWorkItemSearchRead.interpret(reply)
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires `items` and each row's `labels`, and types the other eight (`id`, `type`, `number`, `title`, `state`, `url`, `updatedAt`, `author`). Two gaps keep the cast: the salvaged members type as `T | undefined` where GitHubWorkItem declares them required, and `sources`/`errors`/`issueSourceFellBack` are deliberately `z.unknown()` because the two banner extractors below read them member by member with their own guards.
            const envelope = decoded as {
              items: Array<Omit<GitHubWorkItem, 'repoId' | 'repoName'>>
              sources?: GitHubRepoSources
              errors?: { issues?: { message: string } }
              issueSourceFellBack?: true
            }
            return {
              items: envelope.items.map((item) => createGitHubTask(repo, item)),
              sources: envelope.sources,
              errorTypes: getWorkItemPageErrorTypes(decoded.errors),
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
        items: sortWorkItemsByRecency(
          results.flatMap((result) => result.items),
          (item) => item.source
        ),
        failedCount: results.filter((result) => result.error).length,
        errorTypes: results.flatMap((result) => result.errorTypes ?? []),
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
  return {
    ...model,
    refreshJiraConnection,
    connectJiraAccount,
    loadLinearContext,
    persistLinearTeamSelection,
    fetchGitHubItemsPage,
    countGitHubItemPages
  }
}

export type ProviderLoadActionsModel = ReturnType<
  typeof useMobileTasksProviderLoadActions<RuntimeHydrationModel>
>
