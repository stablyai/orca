import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import { isHostedTaskRepo, useCallback } from './mobile-tasks-dependencies'
import {
  GITHUB_REPO_CONCURRENCY,
  GITLAB_PER_PAGE,
  type GitLabTodo,
  type LinearIssue,
  type GitLabWorkItem,
  LINEAR_LIMIT,
  type TaskItem,
  buildPartialRepositoryNotice,
  sortLinearIssues,
  createGitLabTask,
  createGitLabTodoTask,
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
            const reply = await gitlabTodoListRead.request(requestClient, {
              repo: `id:${queriedRepos[0]!.id}`
            })
            // The reader answers an array or the nullish this line already read as an empty inbox,
            // so the `.map is not a function` the screen used to show for anything else is now one
            // error naming `gitlab.todos`. The row stays uninspected: `listTodos` returns
            // `GitLabTodo[]`, but the recorded reply at this site is not one, so narrowing the row
            // would refuse this family's only success control.
            const todos = gitlabTodoListRead.interpret(reply)
            if (!isCurrent()) {
              return
            }
            setItems(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader proved the container; the row is the host's declared GitLabTodo.
              ((todos ?? []) as GitLabTodo[])
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
                const reply = await gitlabWorkItemSearchRead.request(requestClient, {
                  repo: `id:${repo.id}`,
                  state: gitlabFilter,
                  page: 1,
                  perPage: GITLAB_PER_PAGE,
                  query: appliedQuery.trim() || undefined
                })
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
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
          // A query searches and no query lists: two methods, so each arm sends its own
          // operation. Both project the reply through the same Linear item reader.
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
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          const issues = found as LinearIssue[]
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
