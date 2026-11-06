import {
  applyEmptyPageClamp,
  applyWindowPageLimit,
  deriveAdvertisedTotalPages,
  resolveEmptyPageOutcome
} from '../../../src/shared/work-item-empty-page'
import { translate } from '../i18n/mobile-i18n'
import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  PER_REPO_FETCH_LIMIT,
  getTaskPagePerRepoLimit,
  useCallback,
  useMemo,
  useState
} from './mobile-tasks-dependencies'
import { type TaskItem, buildPartialRepositoryNotice } from './mobile-tasks-legacy-foundation'
import { linearAccountConnect } from './mobile-task-list-operations'

function hasRepoWithFullPage(
  page: readonly Extract<TaskItem, { provider: 'github' }>[],
  perRepoLimit: number
): boolean {
  const rowsByRepo = new Map<string, number>()
  for (const item of page) {
    const rows = (rowsByRepo.get(item.source.repoId) ?? 0) + 1
    if (rows >= perRepoLimit) {
      return true
    }
    rowsByRepo.set(item.source.repoId, rows)
  }
  return false
}

export function useMobileTasksTaskPaginationActions(model: TaskListLoadingModel) {
  const {
    client,
    clientRef,
    connState,
    fetchGitHubItemsPage,
    githubCurrentPage,
    githubPages,
    githubPaginationLoading,
    githubCountedTotalPages,
    linearApiKeyDraft,
    linearConnectState,
    loadGenerationRef,
    loadLinearContext,
    loadTasks,
    selectedHostedRepos,
    setError,
    setGithubCurrentPage,
    setGithubCountedTotalPages,
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
      const reply = await linearAccountConnect.request(client, { apiKey })
      const result = linearAccountConnect.interpret(reply)
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
        // Use authoritative refresh so retries reset rows, errors, counts and pagination together.
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

  const [windowLimit, setWindowLimit] = useState<{ generation: number; pages: number } | null>(null)
  const provenPageLimit =
    windowLimit?.generation === loadGenerationRef.current ? windowLimit.pages : null
  const githubTotalPages = deriveAdvertisedTotalPages({
    loadedPages: githubPages.length,
    countedTotalPages: githubCountedTotalPages,
    fallbackTotalPages: githubPages.length,
    provenPageLimit
  })
  const githubPerRepoLimit = getTaskPagePerRepoLimit(
    selectedHostedRepos.length,
    PER_REPO_FETCH_LIMIT,
    CROSS_REPO_DISPLAY_LIMIT
  )
  // One full per-repo page may have more; all-repo mode skips counts and relies on this to reach page two.
  const githubCanLoadUncountedNextPage =
    !githubCountedTotalPages &&
    (provenPageLimit === null || githubPages.length < provenPageLimit) &&
    hasRepoWithFullPage(githubPages.at(-1) ?? [], githubPerRepoLimit)
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
      // Any list reload supersedes this page; its rows must not enter the new selection/query/provider.
      const generation = loadGenerationRef.current
      const isCurrent = () =>
        loadGenerationRef.current === generation && clientRef.current === client
      setError('')
      setGithubPaginationLoading(true)
      setGithubLoadingTargetPage(targetPage)
      try {
        const page = await fetchGitHubItemsPage(client, selectedHostedRepos, targetPage, isCurrent)
        if (!isCurrent()) {
          return
        }
        if (page.items.length === 0) {
          const emptyPage = {
            target: targetPage,
            failedCount: page.failedCount,
            errorTypes: page.errorTypes
          }
          const { reason } = resolveEmptyPageOutcome({ ...emptyPage, countedTotalPages: null })
          if (reason === 'window-unreachable') {
            setError(
              translate(
                'tasks.pagination.pageUnreachable',
                'Page {{page}} is beyond what GitHub search can return.',
                { page: targetPage + 1 }
              )
            )
            setWindowLimit((previous) => ({
              generation,
              pages: applyWindowPageLimit(
                previous?.generation === generation ? previous.pages : null,
                targetPage
              )
            }))
          } else if (reason === 'load-failed') {
            setError(
              translate(
                'tasks.pagination.loadPageFailed',
                'Page {{page}} could not be loaded from GitHub.',
                { page: targetPage + 1 }
              )
            )
          } else {
            setError(
              translate('tasks.pagination.noMoreResults', 'No more results on page {{page}}.', {
                page: targetPage + 1
              })
            )
            setGithubCountedTotalPages((previous) => applyEmptyPageClamp(previous, emptyPage))
          }
          return
        }
        if (page.failedCount > 0) {
          setError(buildPartialRepositoryNotice(page.failedCount, selectedHostedRepos.length))
        }
        setGithubPages([...githubPages, page.items])
        setGithubCurrentPage(targetPage)
        setItems(page.items)
      } catch (err) {
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : 'Failed to load more GitHub tasks')
        }
      } finally {
        setGithubPaginationLoading(false)
        setGithubLoadingTargetPage(null)
      }
    },
    [
      client,
      clientRef,
      fetchGitHubItemsPage,
      githubPages,
      githubPaginationLoading,
      loadGenerationRef,
      selectedHostedRepos,
      setGithubCountedTotalPages,
      tasksSupported
    ]
  )
  return Object.assign(model, {
    connectLinearAccount,
    retryGitHubIssueSourceFetch,
    githubTotalPages,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubPagePickerPages,
    handleGitHubPageChange
  })
}

export type TaskPaginationActionsModel = ReturnType<typeof useMobileTasksTaskPaginationActions>
