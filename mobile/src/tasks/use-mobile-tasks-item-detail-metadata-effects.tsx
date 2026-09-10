import type { ListAndDetailEffectsModel } from './use-mobile-tasks-list-and-detail-effects'
import { useEffect } from './mobile-tasks-dependencies'

export function useMobileTasksItemDetailMetadataEffects(model: ListAndDetailEffectsModel) {
  const {
    actionItem,
    detailPayload,
    setItemAssignableUsers,
    setItemAssignableUsersError,
    setItemAssignableUsersLoading,
    setItemAvailableLabels,
    setItemBodyDraft,
    setItemLabelsError,
    setItemLabelsLoading,
    taskOperations,
    tasksSupported
  } = model
  useEffect(() => {
    if (!detailPayload) {
      setItemBodyDraft('')
      return
    }
    setItemBodyDraft(
      detailPayload.provider === 'linear' ? detailPayload.description : detailPayload.body
    )
  }, [detailPayload])

  useEffect(() => {
    if (!tasksSupported || !taskOperations || actionItem?.provider !== 'github') {
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
      void taskOperations.detail
        .listGitHubLabels(actionItem.source.repoId)
        .then((labels) => {
          if (stale) {
            return
          }
          setItemAvailableLabels(labels)
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
    void taskOperations.detail
      .listGitHubAssignableUsers(actionItem.source.repoId)
      .then((users) => {
        if (stale) {
          return
        }
        setItemAssignableUsers(users)
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
  }, [actionItem, taskOperations, tasksSupported])
  return model
}

export type ItemDetailMetadataEffectsModel = ReturnType<
  typeof useMobileTasksItemDetailMetadataEffects
>
