import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  PER_REPO_FETCH_LIMIT,
  useCallback,
  useMemo
} from './mobile-tasks-dependencies'
import {
  type TaskItem,
  buildPartialRepositoryNotice,
  isSuccess
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksTaskPaginationActions(model: TaskListLoadingModel) {
  const {
    client,
    connState,
    fetchGitHubItemsPage,
    githubCurrentPage,
    githubPages,
    githubPaginationLoading,
    githubTotalCount,
    linearApiKeyDraft,
    linearConnectState,
    loadLinearContext,
    loadTasks,
    selectedHostedRepos,
    setError,
    setGithubCurrentPage,
    setGithubLoadingTargetPage,
    setGithubPages,
    setGithubPaginationLoading,
    setItems,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setLinearConnected,
    setProvider,
    setRetryingGithubSourceRepoPaths,
    setShowLinearConnect,
    setVisibleProviders,
    taskUiReady,
    tasksSupported
  } = model
  const connectLinearAccount = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !taskUiReady) {
      return
    }
    const apiKey = linearApiKeyDraft.trim()
    if (!apiKey || linearConnectState === 'connecting') {
      return
    }
    setLinearConnectState('connecting')
    setLinearConnectError('')
    try {
      const response = await client.sendRequest('linear.connect', { apiKey })
      if (!isSuccess(response)) {
        throw new Error(response.error.message)
      }
      const result = response.result as { ok?: boolean; error?: string }
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to connect Linear')
      }
      setLinearApiKeyDraft('')
      setLinearConnectState('idle')
      setShowLinearConnect(false)
      setLinearConnected(true)
      setVisibleProviders((current) =>
        current.includes('linear') ? current : [...current, 'linear']
      )
      setProvider('linear')
      await loadLinearContext()
    } catch (err) {
      setLinearConnectState('error')
      setLinearConnectError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [client, connState, linearApiKeyDraft, linearConnectState, loadLinearContext, taskUiReady])

  const retryGitHubIssueSourceFetch = useCallback(
    async (repoPath: string): Promise<void> => {
      setRetryingGithubSourceRepoPaths((current) => {
        const next = new Set(current)
        next.add(repoPath)
        return next
      })
      try {
        // Why: desktop retries through the shared list refresh path so source
        // errors, rows, counts, and pagination reset from one authoritative fetch.
        await loadTasks({ silent: true })
      } finally {
        setRetryingGithubSourceRepoPaths((current) => {
          const next = new Set(current)
          next.delete(repoPath)
          return next
        })
      }
    },
    [loadTasks]
  )

  const githubTotalPages = useMemo(() => {
    const selectedRepoCount = Math.max(1, selectedHostedRepos.length)
    const pageCapacity = Math.max(
      1,
      Math.min(CROSS_REPO_DISPLAY_LIMIT, selectedRepoCount * PER_REPO_FETCH_LIMIT)
    )
    if (githubTotalCount !== null) {
      return Math.max(githubPages.length, Math.ceil(githubTotalCount / pageCapacity))
    }
    return githubPages.length
  }, [githubPages.length, githubTotalCount, selectedHostedRepos.length])
  const githubPageCapacity = useMemo(() => {
    const selectedRepoCount = Math.max(1, selectedHostedRepos.length)
    return Math.max(1, Math.min(CROSS_REPO_DISPLAY_LIMIT, selectedRepoCount * PER_REPO_FETCH_LIMIT))
  }, [selectedHostedRepos.length])
  const githubCanLoadUncountedNextPage =
    githubTotalCount === null && (githubPages.at(-1)?.length ?? 0) >= githubPageCapacity
  const githubCanShowPagination =
    githubTotalPages > 1 || (githubPages.length > 0 && githubCanLoadUncountedNextPage)
  const githubPagePickerPages = useMemo(() => {
    const visible = new Set<number>()
    const availablePages = Math.min(
      githubTotalPages + (githubCanLoadUncountedNextPage ? 1 : 0),
      githubPages.length + (githubCanLoadUncountedNextPage ? 1 : 0)
    )
    for (let index = 0; index < availablePages; index += 1) {
      visible.add(index)
    }
    for (
      let index = Math.max(0, githubCurrentPage - 2);
      index <= Math.min(availablePages - 1, githubCurrentPage + 2);
      index += 1
    ) {
      visible.add(index)
    }
    return [...visible].sort((a, b) => a - b)
  }, [githubCanLoadUncountedNextPage, githubCurrentPage, githubTotalPages])

  const handleGitHubPageChange = useCallback(
    async (targetPage: number): Promise<void> => {
      if (
        !client ||
        !tasksSupported ||
        targetPage < 0 ||
        githubPaginationLoading ||
        selectedHostedRepos.length === 0
      ) {
        return
      }
      if (targetPage > githubPages.length) {
        return
      }
      if (targetPage < githubPages.length) {
        setGithubCurrentPage(targetPage)
        setItems(githubPages[targetPage] ?? [])
        return
      }
      const lastPage = githubPages[githubPages.length - 1]
      const oldestItem = lastPage?.[lastPage.length - 1]
      if (!oldestItem?.updatedAt) {
        return
      }

      setGithubPaginationLoading(true)
      setGithubLoadingTargetPage(targetPage)
      try {
        let cursor = oldestItem.updatedAt
        let loadedPages = githubPages.length
        const nextPages: Array<Extract<TaskItem, { provider: 'github' }>[]> = []
        while (loadedPages <= targetPage) {
          const page = await fetchGitHubItemsPage(client, selectedHostedRepos, cursor)
          if (page.items.length === 0) {
            break
          }
          if (page.failedCount > 0) {
            setError(buildPartialRepositoryNotice(page.failedCount, selectedHostedRepos.length))
          }
          nextPages.push(page.items)
          cursor = page.items[page.items.length - 1]!.updatedAt
          loadedPages += 1
        }
        if (nextPages.length === 0) {
          return
        }
        const allPages = [...githubPages, ...nextPages]
        const nextPage = targetPage < loadedPages ? targetPage : loadedPages - 1
        setGithubPages(allPages)
        setGithubCurrentPage(nextPage)
        setItems(allPages[nextPage] ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load more GitHub tasks')
      } finally {
        setGithubPaginationLoading(false)
        setGithubLoadingTargetPage(null)
      }
    },
    [
      client,
      fetchGitHubItemsPage,
      githubPages,
      githubPaginationLoading,
      selectedHostedRepos,
      tasksSupported
    ]
  )
  return Object.assign(model, {
    connectLinearAccount,
    retryGitHubIssueSourceFetch,
    githubTotalPages,
    githubPageCapacity,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubPagePickerPages,
    handleGitHubPageChange
  })
}

export type TaskPaginationActionsModel = ReturnType<typeof useMobileTasksTaskPaginationActions>
