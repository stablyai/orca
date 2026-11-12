import { useQueryClient } from '@tanstack/react-query'
import { linearIssueReadFailureMessage } from '../../../../src/shared/integration-credential-errors'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import { isHostedTaskRepo } from '../repositories/hosted-repo-selection'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { readTaskListRows } from './task-list-read'
import { readTaskList, taskListParams } from '../screen-state/task-queries'
import { taskListKey } from '../screen-state/task-query-storage'
import { useTaskListCache } from './use-task-list-cache'

export function useMobileTasksTaskListLoading(model: ProviderLoadActionsModel) {
  const {
    appliedQuery,
    client,
    clientRef,
    connState,
    countGitHubItemPages,
    fetchGitHubItemsPage,
    githubKind,
    githubMode,
    gitlabFilter,
    gitlabView,
    linearConnected,
    jiraConnection,
    jiraFilter,
    linearFilter,
    linearOrderBy,
    hostId,
    loadGenerationRef,
    provider,
    repoListEnsureLoaded,
    resetGitHubItemsState,
    selectedLinearTeamIds,
    selectedLinearWorkspaceId,
    selectedRepoIds,
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
    setTaskListSettled,
    taskStateHydrated,
    tasksSupported
  } = model
  const queryClient = useQueryClient()
  const unsettledLoadRef = useRef(0)
  const { begin, shown, settle, rememberPageCount, cancelRead, revalidating, rowsReadAt } =
    useTaskListCache(model)
  // By content, so re-picking the same repos (a new Set) does not re-read.
  const savedRepoKey = [...selectedRepoIds].sort().join('\n')
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
      // Reads only inputs in this callback's dependencies.
      const params = taskListParams(model, savedRepoKey)
      const listKey = params && taskListKey(hostId, params)
      setError('')
      if (options.silent) {
        setRefreshing(true)
      } else {
        begin(params, provider)
      }
      try {
        if (provider !== 'github' || githubMode !== 'items') {
          resetGitHubItemsState()
        }
        // Jira/Linear need repos only for workspace creation, not issue reads.
        const repoListRequest = repoListEnsureLoaded()
        void repoListRequest.catch(() => {})
        const hosted = provider === 'github' || provider === 'gitlab'
        const repos = hosted
          ? (await repoListRequest)
              .filter(isHostedTaskRepo)
              .filter((repo) => effectiveRepoIds.size === 0 || effectiveRepoIds.has(repo.id))
          : []
        if (!isCurrent()) {
          return
        }
        // Project rows match against repos without listing work items; a hosted filter with no repos has nothing to read.
        if (!params || (hosted && repos.length === 0)) {
          setItems([])
          resetGitHubItemsState()
          return
        }
        const snapshot = await readTaskList(
          queryClient,
          { hostId, client: requestClient },
          params,
          (signal) => readTaskListRows({ ...model, client: requestClient, repos }, signal)
        )
        if (!isCurrent()) {
          return
        }
        shown(provider, params)
        setItems(snapshot.items)
        setError(snapshot.notice ?? '')
        if (snapshot.github) {
          setGithubRepoSources((current) => ({ ...current, ...snapshot.github.sources }))
          setGithubSourceErrors(snapshot.github.sourceErrors)
          setGithubSourceFallbacks(snapshot.github.sourceFallbacks)
          setGithubPages([snapshot.items])
          setGithubCurrentPage(0)
          if (effectiveRepoIds.size > 0) {
            void countGitHubItemPages(requestClient, repos, isCurrent).then((totalPages) => {
              if (isCurrent()) {
                setGithubCountedTotalPages(totalPages)
                rememberPageCount(listKey, totalPages)
              }
            })
          } else {
            // Do not spend GitHub Search quota on all-repo totals before the user narrows scope.
            setGithubCountedTotalPages(null)
          }
        }
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        setItems([])
        resetGitHubItemsState()
        setError(
          provider === 'linear'
            ? linearIssueReadFailureMessage(err)
            : err instanceof Error
              ? err.message
              : 'Failed to load tasks'
        )
      } finally {
        if (unsettledLoadRef.current === generation) {
          unsettledLoadRef.current = 0
        }
        if (isCurrent()) {
          setLoading(false)
          setRefreshing(false)
          settle()
          setTaskListSettled(true)
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
      githubKind,
      githubMode,
      hostId,
      jiraConnection,
      jiraFilter,
      linearConnected,
      linearFilter,
      linearOrderBy,
      begin,
      queryClient,
      rememberPageCount,
      settle,
      shown,
      repoListEnsureLoaded,
      provider,
      selectedLinearTeamIds,
      selectedLinearWorkspaceId,
      savedRepoKey,
      effectiveRepoIds,
      taskStateHydrated,
      tasksSupported
    ]
  )
  const currentLoader = useRef<typeof loadTasks | null>(loadTasks)
  useLayoutEffect(() => {
    currentLoader.current = loadTasks
    return () => {
      currentLoader.current = null
    }
  }, [loadTasks])
  const captureTaskListRefresh = useCallback(() => {
    const generation = client?.getGeneration?.()
    const loadGeneration = loadGenerationRef.current
    return () => {
      if (
        currentLoader.current === loadTasks &&
        loadGenerationRef.current === loadGeneration &&
        clientRef.current === client &&
        client?.getGeneration?.() === generation
      ) {
        void loadTasks({ silent: true })
      }
    }
  }, [client, clientRef, loadTasks, loadGenerationRef])
  // Abandoning an in-flight load must release its spinners; a successor load in the same commit re-sets them.
  useEffect(
    () => () => {
      loadGenerationRef.current += 1
      cancelRead()
      if (unsettledLoadRef.current !== 0) {
        unsettledLoadRef.current = 0
        setLoading(false)
        setRefreshing(false)
        settle()
      }
    },
    [cancelRead, loadTasks, loadGenerationRef, setLoading, setRefreshing, settle]
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
  return Object.assign(model, { loadTasks, captureTaskListRefresh, revalidating, rowsReadAt })
}

export type TaskListLoadingModel = ReturnType<typeof useMobileTasksTaskListLoading>
