import type { ListAndDetailEffectsModel } from './use-mobile-tasks-list-and-detail-effects'
import { useEffect } from './mobile-tasks-dependencies'
import {
  githubAssignableUserListRead,
  githubRepoLabelListRead
} from './mobile-task-item-detail-operations'
import { detailPayloadBody } from './mobile-tasks-provider-detail-types'

export function useMobileTasksItemDetailMetadataEffects(model: ListAndDetailEffectsModel) {
  const {
    actionItem,
    client,
    detailPayload,
    setItemAssignableUsers,
    setItemAssignableUsersError,
    setItemAssignableUsersLoading,
    setItemAvailableLabels,
    setItemBodyDraft,
    setItemLabelsError,
    setItemLabelsLoading,
    tasksSupported
  } = model
  useEffect(() => {
    if (!detailPayload) {
      setItemBodyDraft('')
      return
    }
    setItemBodyDraft(detailPayloadBody(detailPayload))
  }, [detailPayload])

  useEffect(() => {
    if (!tasksSupported || !client || actionItem?.provider !== 'github') {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
      setItemAssignableUsers([])
      setItemAssignableUsersLoading(false)
      setItemAssignableUsersError('')
      return
    }

    let stale = false
    if (actionItem.source.type === 'issue' || actionItem.source.type === 'pr') {
      setItemAvailableLabels([])
      setItemLabelsError('')
      setItemLabelsLoading(true)
      void githubRepoLabelListRead
        .request(client, { repo: `id:${actionItem.source.repoId}` }, { timeoutMs: 30_000 })
        .then((response) => {
          if (stale) {
            return
          }
          setItemAvailableLabels(githubRepoLabelListRead.interpret(response))
        })
        .catch((err) => {
          if (!stale) {
            setItemLabelsError(err instanceof Error ? err.message : 'Failed to load labels')
          }
        })
        .finally(() => {
          if (!stale) {
            setItemLabelsLoading(false)
          }
        })
    } else {
      setItemAvailableLabels([])
      setItemLabelsLoading(false)
      setItemLabelsError('')
    }

    setItemAssignableUsers([])
    setItemAssignableUsersError('')
    setItemAssignableUsersLoading(true)
    void githubAssignableUserListRead
      .request(client, { repo: `id:${actionItem.source.repoId}` }, { timeoutMs: 30_000 })
      .then((response) => {
        if (stale) {
          return
        }
        setItemAssignableUsers(githubAssignableUserListRead.interpret(response))
      })
      .catch((err) => {
        if (!stale) {
          setItemAssignableUsersError(
            err instanceof Error ? err.message : 'Failed to load assignees'
          )
        }
      })
      .finally(() => {
        if (!stale) {
          setItemAssignableUsersLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, client, tasksSupported])
  return model
}

export type ItemDetailMetadataEffectsModel = ReturnType<
  typeof useMobileTasksItemDetailMetadataEffects
>
