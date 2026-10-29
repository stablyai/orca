import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import { fetchJiraTaskIssues } from './mobile-jira-task-source'
import { isHostedTaskRepo, useCallback, useEffect, useRef } from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  GITLAB_PER_PAGE,
  type GitLabWorkItem,
  LINEAR_LIMIT,
  type TaskItem,
  buildPartialRepositoryNotice,
  sortLinearIssues,
  createGitLabTask,
  createGitLabTodoTask,
  createJiraTask,
  createLinearTask,
  mapWithConcurrency,
  taskTime
} from './mobile-tasks-legacy-foundation'
import { gitlabTodoListRead } from './mobile-task-list-operations'
import {
  gitlabWorkItemSearchRead,
  linearAssignedIssueListRead,
  linearIssueSearchRead
} from './mobile-task-source-search-operations'

export function useMobileTasksTaskListLoading(model: ProviderLoadActionsModel) {
  const {
    appliedQuery,
    client,
    clientRef,
    connState,
    countGitHubItemPages,
    fetchGitHubItemsPage,
    githubMode,
    gitlabFilter,
    gitlabView,
    linearConnected,
    jiraConnection,
    jiraFilter,
    linearFilter,
    linearOrderBy,
    loadGenerationRef,
    provider,
    repoListEnsureLoaded,
    resetGitHubItemsState,
    selectedLinearTeamIds,
    selectedLinearWorkspaceId,
    effectiveRepoIds,
    serverRepoList,
    setError,
    setGithubCurrentPage,
    setGithubPages,
    setGithubRepoSources,
    setGithubSourceErrors,
    setGithubSourceFallbacks,
    setGithubCountedTotalPages,
    setItems,
    setLoading,
    setRefreshing,
    taskStateHydrated,
    tasksSupported
  } = model
  const unsettledLoadRef = useRef(0)
  const loadTasks = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
        return
      }
      const generation = loadGenerationRef.current + 1
      loadGenerationRef.current = generation
      unsettledLoadRef.current = generation
      const requestClient = client
      const isCurrent = () =>
        loadGenerationRef.current === generation && clientRef.current === requestClient
      setError('')
      if (options.silent) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      try {
        if (provider !== 'github' || githubMode !== 'items') {
          resetGitHubItemsState()
        }
        if (provider === 'linear' && !linearConnected) {
          setItems([])
          return
        }
        // Jira/Linear need repos only for workspace creation, not issue reads.
        const repoListRequest = repoListEnsureLoaded()
        void repoListRequest.catch(() => {})
        if (provider === 'jira') {
          if (!jiraConnection.connected) {
            setItems([])
            return
          }
          const issues = await fetchJiraTaskIssues(requestClient, {
            jql: appliedQuery,
            filter: jiraFilter,
            siteId: jiraConnection.selection
          })
          if (isCurrent()) {
            setItems(issues.map(createJiraTask))
          }
          return
        }
        const currentRepos = provider === 'linear' ? [] : await repoListRequest
        if (!isCurrent()) {
          return
        }
        // Project rows match against repos even without fetching work items; load repos before returning.
        if (provider === 'github' && githubMode === 'project') {
          setItems([])
          return
        }
        if (provider === 'github' || provider === 'gitlab') {
          const supportedRepos = currentRepos.filter(isHostedTaskRepo)
          const queriedRepos =
            effectiveRepoIds.size === 0
              ? supportedRepos
              : supportedRepos.filter((repo) => effectiveRepoIds.has(repo.id))
          if (queriedRepos.length === 0) {
            if (!isCurrent()) {
              return
            }
            setItems([])
            resetGitHubItemsState()
            return
          }
          if (provider === 'github') {
            const page = await fetchGitHubItemsPage(requestClient, queriedRepos, 0, isCurrent)
            if (!isCurrent()) {
              return
            }
            setGithubRepoSources((current) => ({ ...current, ...page.sourcesByRepoId }))
            setGithubSourceErrors(page.sourceErrors)
            setGithubSourceFallbacks(page.sourceFallbacks)
            if (page.failedCount === queriedRepos.length) {
              throw new Error('Failed to load GitHub tasks')
            }
            setGithubPages([page.items])
            setGithubCurrentPage(0)
            setItems(page.items)
            if (effectiveRepoIds.size > 0) {
              void countGitHubItemPages(requestClient, queriedRepos, isCurrent).then(
                (totalPages) => {
                  if (isCurrent()) {
                    setGithubCountedTotalPages(totalPages)
                  }
                }
              )
            } else {
              // Do not spend GitHub Search quota on all-repo totals before the user narrows scope.
              setGithubCountedTotalPages(null)
            }
            if (page.failedCount > 0) {
              setError(buildPartialRepositoryNotice(page.failedCount, queriedRepos.length))
            } else {
              setError('')
            }
            return
          }
          if (provider === 'gitlab' && gitlabView === 'todos') {
            const reply = await gitlabTodoListRead.request(requestClient, {
              repo: `id:${queriedRepos[0]!.id}`
            })
            const todos = gitlabTodoListRead.interpret(reply)
            if (!isCurrent()) {
              return
            }
            setItems(
              (todos ?? [])
                .map(createGitLabTodoTask)
                .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
            )
            return
          }
          const results = await mapWithConcurrency(
            queriedRepos,
            GITHUB_REPO_CONCURRENCY,
            async (repo) => {
              if (!isCurrent()) {
                return { items: [] }
              }
              try {
                const reply = await gitlabWorkItemSearchRead.request(requestClient, {
                  repo: `id:${repo.id}`,
                  state: gitlabFilter,
                  page: 1,
                  perPage: GITLAB_PER_PAGE,
                  query: appliedQuery.trim() || undefined
                })
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires `items` and types each row at `GitLabWorkItem`'s own member types, requiring the ones a consumer reads unguarded; the row builder's own reads are unchanged.
                const envelope = gitlabWorkItemSearchRead.interpret(reply) as {
                  items: Array<Omit<GitLabWorkItem, 'repoId' | 'repoName'>>
                  error?: { type?: string; message: string }
                }
                if (envelope.error?.type && envelope.error.type !== 'not_found') {
                  return { items: [], error: envelope.error.message }
                }
                return { items: envelope.items.map((item) => createGitLabTask(repo, item)) }
              } catch (err) {
                console.warn(`[mobile tasks] failed to fetch ${provider} work items`, repo.id, err)
                return {
                  items: [] as TaskItem[],
                  error: err instanceof Error ? err.message : 'Failed to load GitLab tasks'
                }
              }
            }
          )
          if (!isCurrent()) {
            return
          }
          const failedCount = results.filter((result) => result.error).length
          if (failedCount === queriedRepos.length) {
            throw new Error(
              results.find((result) => result.error)?.error ?? 'Failed to load GitLab tasks'
            )
          }
          setItems(
            results
              .flatMap((result) => result.items)
              .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
          )
          if (failedCount > 0) {
            setError(buildPartialRepositoryNotice(failedCount, queriedRepos.length))
          } else {
            setError('')
          }
        } else {
          const normalizedQuery = appliedQuery.trim()
          const found = normalizedQuery
            ? linearIssueSearchRead.interpret(
                await linearIssueSearchRead.request(requestClient, {
                  query: normalizedQuery,
                  limit: LINEAR_LIMIT,
                  workspaceId: selectedLinearWorkspaceId ?? undefined
                })
              )
            : linearAssignedIssueListRead.interpret(
                await linearAssignedIssueListRead.request(requestClient, {
                  filter: linearFilter,
                  limit: LINEAR_LIMIT,
                  workspaceId: selectedLinearWorkspaceId ?? undefined
                })
              )
          const issues = found
          const filtered =
            selectedLinearTeamIds.size > 0
              ? issues.filter((issue) => selectedLinearTeamIds.has(issue.team.id))
              : issues
          const sorted = sortLinearIssues(filtered, linearOrderBy)
          if (!isCurrent()) {
            return
          }
          setItems(sorted.map(createLinearTask))
        }
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setItems([])
        resetGitHubItemsState()
        setError(err instanceof Error ? err.message : 'Failed to load tasks')
      } finally {
        if (unsettledLoadRef.current === generation) {
          unsettledLoadRef.current = 0
        }
        if (isCurrent()) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [
      appliedQuery,
      client,
      connState,
      countGitHubItemPages,
      fetchGitHubItemsPage,
      gitlabFilter,
      gitlabView,
      githubMode,
      jiraConnection,
      jiraFilter,
      linearConnected,
      linearFilter,
      linearOrderBy,
      repoListEnsureLoaded,
      provider,
      selectedLinearTeamIds,
      selectedLinearWorkspaceId,
      effectiveRepoIds,
      taskStateHydrated,
      tasksSupported
    ]
  )
  // Abandoning an in-flight load must release its spinners; a successor load in the same commit re-sets them.
  useEffect(
    () => () => {
      loadGenerationRef.current += 1
      if (unsettledLoadRef.current !== 0) {
        unsettledLoadRef.current = 0
        setLoading(false)
        setRefreshing(false)
      }
    },
    [loadTasks, loadGenerationRef, setLoading, setRefreshing]
  )
  // Server-repo changes quietly reload unfiltered lists; a changed loadTasks already owns filter reloads, while Jira/Linear read independently.
  const listedServerReposRef = useRef({ serverRepoList, loadTasks })
  useEffect(() => {
    const prev = listedServerReposRef.current
    listedServerReposRef.current = { serverRepoList, loadTasks }
    if (
      prev.serverRepoList !== serverRepoList &&
      prev.loadTasks === loadTasks &&
      effectiveRepoIds.size === 0 &&
      (provider === 'github' || provider === 'gitlab') &&
      connState === 'connected' &&
      taskStateHydrated
    ) {
      void loadTasks({ silent: true })
    }
  }, [serverRepoList, loadTasks, effectiveRepoIds.size, provider, connState, taskStateHydrated])
  return Object.assign(model, { loadTasks })
}

export type TaskListLoadingModel = ReturnType<typeof useMobileTasksTaskListLoading>
