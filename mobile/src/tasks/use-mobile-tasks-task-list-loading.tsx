import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import {
  extractLinearIssueReadItems,
  isHostedTaskRepo,
  useCallback
} from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  GITLAB_PER_PAGE,
  type GitLabTodo,
  type GitLabWorkItem,
  LINEAR_LIMIT,
  type TaskItem,
  buildPartialRepositoryNotice,
  compareLinearIssues,
  createGitLabTask,
  createGitLabTodoTask,
  createLinearTask,
  isSuccess,
  mapWithConcurrency,
  taskTime
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksTaskListLoading(model: ProviderLoadActionsModel) {
  const {
    appliedQuery,
    client,
    clientRef,
    connState,
    countGitHubItems,
    fetchGitHubItemsPage,
    githubMode,
    gitlabFilter,
    gitlabView,
    linearConnected,
    linearFilter,
    linearOrderBy,
    loadGenerationRef,
    provider,
    repoListEnsureLoaded,
    resetGitHubItemsState,
    selectedLinearTeamIds,
    selectedLinearWorkspaceId,
    selectedRepoIds,
    setError,
    setGithubCurrentPage,
    setGithubPages,
    setGithubRepoSources,
    setGithubSourceErrors,
    setGithubSourceFallbacks,
    setGithubTotalCount,
    setItems,
    setLoading,
    setRefreshing,
    taskStateHydrated,
    tasksSupported
  } = model
  const loadTasks = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      if (!client || connState !== 'connected' || !tasksSupported || !taskStateHydrated) {
        return
      }
      const generation = loadGenerationRef.current + 1
      loadGenerationRef.current = generation
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
        // Why: Linear issues do not need the repo list, only the composer does, so
        // start the fetch either way but never make Linear wait on it.
        const repoListRequest = repoListEnsureLoaded()
        void repoListRequest.catch(() => {})
        const currentRepos = provider === 'linear' ? [] : await repoListRequest
        if (!isCurrent()) {
          return
        }
        // Why: project mode fetches no work items, but its rows are matched against
        // the repo list, so it must not return before loadRepos() has run.
        if (provider === 'github' && githubMode === 'project') {
          setItems([])
          return
        }
        if (provider === 'github' || provider === 'gitlab') {
          const supportedRepos = currentRepos.filter(isHostedTaskRepo)
          const queriedRepos =
            selectedRepoIds.size === 0
              ? supportedRepos
              : supportedRepos.filter((repo) => selectedRepoIds.has(repo.id))
          if (queriedRepos.length === 0) {
            if (!isCurrent()) {
              return
            }
            setItems([])
            resetGitHubItemsState()
            return
          }
          if (provider === 'github') {
            const page = await fetchGitHubItemsPage(requestClient, queriedRepos)
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
            if (selectedRepoIds.size > 0) {
              void countGitHubItems(requestClient, queriedRepos).then((count) => {
                if (isCurrent()) {
                  setGithubTotalCount(count)
                }
              })
            } else {
              // Why: the default all-repos view must not spend GitHub Search
              // quota on totals before the user narrows the repository scope.
              setGithubTotalCount(null)
            }
            if (page.failedCount > 0) {
              setError(buildPartialRepositoryNotice(page.failedCount, queriedRepos.length))
            } else {
              setError('')
            }
            return
          }
          if (provider === 'gitlab' && gitlabView === 'todos') {
            const response = await requestClient.sendRequest('gitlab.todos', {
              repo: `id:${queriedRepos[0]!.id}`
            })
            if (!isSuccess(response)) {
              throw new Error(response.error.message)
            }
            if (!isCurrent()) {
              return
            }
            setItems(
              ((response.result as GitLabTodo[]) ?? [])
                .map(createGitLabTodoTask)
                .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
            )
            return
          }
          const results = await mapWithConcurrency(
            queriedRepos,
            GITHUB_REPO_CONCURRENCY,
            async (repo) => {
              try {
                const response = await requestClient.sendRequest('gitlab.listWorkItems', {
                  repo: `id:${repo.id}`,
                  state: gitlabFilter,
                  page: 1,
                  perPage: GITLAB_PER_PAGE,
                  query: appliedQuery.trim() || undefined
                })
                if (!isSuccess(response)) {
                  throw new Error(response.error.message)
                }
                const envelope = response.result as {
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
          const response = normalizedQuery
            ? await requestClient.sendRequest('linear.searchIssues', {
                query: normalizedQuery,
                limit: LINEAR_LIMIT,
                workspaceId: selectedLinearWorkspaceId ?? undefined
              })
            : await requestClient.sendRequest('linear.listIssues', {
                filter: linearFilter,
                limit: LINEAR_LIMIT,
                workspaceId: selectedLinearWorkspaceId ?? undefined
              })
          if (!isSuccess(response)) {
            throw new Error(response.error.message)
          }
          const issues = extractLinearIssueReadItems(response.result)
          const filtered =
            selectedLinearTeamIds.size > 0
              ? issues.filter((issue) => selectedLinearTeamIds.has(issue.team.id))
              : issues
          const sorted = [...filtered].sort((a, b) => compareLinearIssues(a, b, linearOrderBy))
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
      countGitHubItems,
      fetchGitHubItemsPage,
      gitlabFilter,
      gitlabView,
      githubMode,
      linearConnected,
      linearFilter,
      linearOrderBy,
      // resetGitHubItemsState is useCallback([]), so its identity never changes
      // and listing it here would only cost a line against the max-lines budget.
      repoListEnsureLoaded,
      provider,
      selectedLinearTeamIds,
      selectedLinearWorkspaceId,
      selectedRepoIds,
      taskStateHydrated,
      tasksSupported
    ]
  )
  return Object.assign(model, { loadTasks })
}

export type TaskListLoadingModel = ReturnType<typeof useMobileTasksTaskListLoading>
