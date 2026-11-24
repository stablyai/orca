import { useCallback, useEffect, useState } from 'react'
import type { ClickUpStatusOption } from '../../../../../src/shared/clickup/clickup-types'
import { translate } from '../../../i18n/mobile-i18n'
import { createClickUpTask } from '../../item-detail/mobile-tasks-item-mapping'
import type { LinearItemActionsModel } from '../linear/use-mobile-tasks-linear-item-actions'
import type { DetailComment } from '../../mobile-tasks-provider-detail-types'
import type { TaskItem } from '../../mobile-tasks-project-workspace-types'
import {
  clickUpCommentWrite,
  clickUpStatusesRead,
  clickUpTaskUpdate
} from './mobile-clickup-operations'
import { appendClickUpComment } from './mobile-clickup-task-source'

const WRITE_TIMEOUT_MS = 30_000

type ClickUpItem = Extract<TaskItem, { provider: 'clickup' }>

export function useMobileTasksClickUpItemActions<
  Model extends Pick<
    LinearItemActionsModel,
    | 'captureTaskListRefresh'
    | 'clickupStatusPickerItem'
    | 'client'
    | 'itemCommentDraft'
    | 'setActionItem'
    | 'setDetailPayload'
    | 'setError'
    | 'setItemCommentDraft'
    | 'setItems'
    | 'taskUiReady'
    | 'tryBeginMutation'
  >
>(model: Model) {
  const {
    captureTaskListRefresh,
    clickupStatusPickerItem,
    client,
    itemCommentDraft,
    setActionItem,
    setDetailPayload,
    setError,
    setItemCommentDraft,
    setItems,
    taskUiReady,
    tryBeginMutation
  } = model
  const [clickupStatusOptions, setClickUpStatusOptions] = useState<ClickUpStatusOption[]>([])
  const [clickupStatusesLoading, setClickUpStatusesLoading] = useState(false)
  const [clickupStatusesError, setClickUpStatusesError] = useState('')

  // A list's statuses are its own, so the picker reads them for the open task's list each time it opens.
  const statusListId = clickupStatusPickerItem?.source.list.id ?? null
  useEffect(() => {
    setClickUpStatusOptions([])
    setClickUpStatusesError('')
    if (!client || !taskUiReady || !statusListId) {
      setClickUpStatusesLoading(false)
      return
    }
    let stale = false
    setClickUpStatusesLoading(true)
    void clickUpStatusesRead
      .request(client, { listId: statusListId }, { timeoutMs: WRITE_TIMEOUT_MS })
      .then((reply) => {
        if (!stale) {
          setClickUpStatusOptions(
            [...clickUpStatusesRead.interpret(reply)].sort((a, b) => a.orderIndex - b.orderIndex)
          )
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          setClickUpStatusesError(
            err instanceof Error
              ? err.message
              : translate('tasks.clickUp.loadStatusesFailed', 'Failed to load statuses')
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setClickUpStatusesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [client, statusListId, taskUiReady])

  const addClickUpComment = useCallback(
    async (item: ClickUpItem): Promise<void> => {
      if (!client) {
        return
      }
      const body = itemCommentDraft.trim()
      if (!body) {
        return
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return
      }
      setError('')
      try {
        const reply = await clickUpCommentWrite.request(
          client,
          { id: item.source.id, body },
          { timeoutMs: WRITE_TIMEOUT_MS }
        )
        const result = clickUpCommentWrite.interpret(reply)
        if (!result.ok) {
          throw new Error(
            result.error ?? translate('tasks.clickUp.addCommentFailed', 'Failed to add comment')
          )
        }
        const comment: DetailComment = {
          id: result.id ?? `local-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          author: translate('tasks.clickUp.you', 'You')
        }
        setItemCommentDraft('')
        setDetailPayload((current) => appendClickUpComment(current, item.source.id, comment))
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : translate('tasks.clickUp.addCommentFailed', 'Failed to add comment')
        )
      } finally {
        finish()
      }
    },
    [client, itemCommentDraft, setItemCommentDraft, tryBeginMutation]
  )

  /** True once the host confirmed the new status and the rows on screen carry it. */
  const setClickUpStatus = useCallback(
    async (item: ClickUpItem, status: ClickUpStatusOption): Promise<boolean> => {
      if (!client || !taskUiReady) {
        return false
      }
      const finish = tryBeginMutation()
      if (!finish) {
        return false
      }
      const refreshList = captureTaskListRefresh()
      setError('')
      try {
        const reply = await clickUpTaskUpdate.request(
          client,
          { id: item.source.id, updates: { status: status.name } },
          { timeoutMs: WRITE_TIMEOUT_MS }
        )
        const result = clickUpTaskUpdate.interpret(reply)
        if (!result.ok) {
          throw new Error(
            result.error ?? translate('tasks.clickUp.updateFailed', 'Failed to update task')
          )
        }
        setItems((current) =>
          current.map((entry) =>
            entry.provider === 'clickup' && entry.source.id === item.source.id
              ? createClickUpTask({ ...entry.source, status })
              : entry
          )
        )
        setActionItem((current) =>
          current?.provider === 'clickup' && current.source.id === item.source.id
            ? createClickUpTask({ ...current.source, status })
            : current
        )
        refreshList()
        return true
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : translate('tasks.clickUp.updateFailed', 'Failed to update task')
        )
        return false
      } finally {
        finish()
      }
    },
    [captureTaskListRefresh, client, taskUiReady, tryBeginMutation]
  )
  return Object.assign(model, {
    clickupStatusOptions,
    clickupStatusesLoading,
    clickupStatusesError,
    addClickUpComment,
    setClickUpStatus
  })
}

export type ClickUpItemActionsModel = LinearItemActionsModel &
  ReturnType<typeof useMobileTasksClickUpItemActions>
