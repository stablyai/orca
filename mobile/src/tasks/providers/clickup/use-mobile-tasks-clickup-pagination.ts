import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { translate } from '../../../i18n/mobile-i18n'
import { createClickUpTask } from '../../item-detail/mobile-tasks-item-mapping'
import type { TaskItem } from '../../mobile-tasks-project-workspace-types'
import { taskListParams, type TaskListSnapshot } from '../../screen-state/task-queries'
import { taskListKey } from '../../screen-state/task-query-storage'
import type { TaskListLoadingModel } from '../../task-list/use-mobile-tasks-task-list-loading'
import { fetchClickUpTaskPage } from './mobile-clickup-task-source'

type ClickUpItem = Extract<TaskItem, { provider: 'clickup' }>

// A task can move between pages while the list is read, so a later page may repeat a row.
function appendNewClickUpItems(
  current: readonly TaskItem[],
  loaded: readonly ClickUpItem[]
): TaskItem[] {
  const seen = new Set(current.map((item) => item.key))
  return [...current, ...loaded.filter((item) => !seen.has(item.key))]
}

/** Reads the host's next page of the open ClickUp list onto the rows already shown, and keeps the stored list in step. */
export function useMobileTasksClickUpPagination(model: TaskListLoadingModel) {
  const {
    appliedQuery,
    client,
    clientRef,
    clickupFilter,
    clickupLoadingMore,
    clickupNextPage,
    hostId,
    loadGenerationRef,
    loading,
    provider,
    refreshing,
    revalidating,
    setClickUpLoadingMore,
    setClickUpNextPage,
    setError,
    setItems,
    tasksSupported
  } = model
  const queryClient = useQueryClient()
  return useCallback(async (): Promise<void> => {
    if (
      !client ||
      !tasksSupported ||
      provider !== 'clickup' ||
      clickupNextPage === null ||
      clickupLoadingMore ||
      loading ||
      refreshing ||
      revalidating
    ) {
      return
    }
    // Any list reload supersedes this page; its rows must not enter the new filter or query.
    const generation = loadGenerationRef.current
    const isCurrent = () => loadGenerationRef.current === generation && clientRef.current === client
    const params = taskListParams(model, '')
    setError('')
    setClickUpLoadingMore(true)
    try {
      const page = await fetchClickUpTaskPage(client, {
        query: appliedQuery,
        filter: clickupFilter,
        page: clickupNextPage
      })
      if (!isCurrent()) {
        return
      }
      const loaded = page.tasks.map(createClickUpTask)
      setItems((current) => appendNewClickUpItems(current, loaded))
      setClickUpNextPage(page.nextPage)
      if (params) {
        queryClient.setQueryData<TaskListSnapshot>(taskListKey(hostId, params), (snapshot) =>
          snapshot?.clickup
            ? {
                ...snapshot,
                items: appendNewClickUpItems(snapshot.items, loaded).filter(
                  (item): item is ClickUpItem => item.provider === 'clickup'
                ),
                clickup: { nextPage: page.nextPage }
              }
            : snapshot
        )
      }
    } catch (err) {
      if (isCurrent()) {
        setError(
          err instanceof Error
            ? err.message
            : translate('tasks.clickUp.loadMoreFailed', 'Failed to load more ClickUp tasks')
        )
      }
    } finally {
      setClickUpLoadingMore(false)
    }
  }, [
    appliedQuery,
    clickupFilter,
    clickupLoadingMore,
    clickupNextPage,
    client,
    clientRef,
    hostId,
    loadGenerationRef,
    loading,
    provider,
    queryClient,
    refreshing,
    revalidating,
    tasksSupported
  ])
}
