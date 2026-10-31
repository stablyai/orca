import {
  SHOW_MOBILE_DETAIL_METADATA_EDITORS,
  SHOW_MOBILE_DETAIL_REVIEW_PANELS
} from './mobile-tasks-options'
import { withGitHubTargetOperation } from './github-work-item-operation'
import { requireGitHubTaskTarget } from './github-task-identity'
import type { ListAndDetailEffectsModel } from './use-mobile-tasks-list-and-detail-effects'
import { useEffect } from './mobile-tasks-dependencies'
import {
  githubAssignableUserListRead,
  githubRepoLabelListRead
} from './mobile-task-item-detail-operations'
import { detailPayloadBody } from './mobile-tasks-provider-detail-types'

export function useMobileTasksItemDetailMetadataEffects<
  Model extends Pick<
    ListAndDetailEffectsModel,
    | 'claimPublication'
    | 'actionItem'
    | 'client'
    | 'detailPayload'
    | 'setItemAssignableUsers'
    | 'setItemAssignableUsersError'
    | 'setItemAssignableUsersLoading'
    | 'setItemAvailableLabels'
    | 'setItemBodyDraft'
    | 'setItemLabelsError'
    | 'setItemLabelsLoading'
    | 'tasksSupported'
  >
>(model: Model) {
  const {
    claimPublication,
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
    const wantsLabels = SHOW_MOBILE_DETAIL_METADATA_EDITORS
    const wantsUsers = SHOW_MOBILE_DETAIL_METADATA_EDITORS || SHOW_MOBILE_DETAIL_REVIEW_PANELS
    if (!wantsLabels && !wantsUsers) {
      return
    }
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
    const canPublish = claimPublication(actionItem)
    const loadRepositoryList = async <T,>(
      send: (
        selected: NonNullable<typeof client>,
        exact: {
          ownerRepo?: import('../../../src/shared/github/pull-request-types').GitHubOwnerRepo
        },
        options: import('../transport/rpc-client').SendRequestOptions
      ) => Promise<T>
    ) => {
      const target = requireGitHubTaskTarget(actionItem.source)
      return withGitHubTargetOperation({
        client,
        params: { repo: `id:${actionItem.source.repoId}` },
        ownerRepo: target.repository,
        send
      })
    }
    if (wantsLabels) {
      setItemAvailableLabels([])
      setItemLabelsError('')
      setItemLabelsLoading(true)
      void loadRepositoryList((selected, exact, options) =>
        githubRepoLabelListRead.request(
          selected,
          { repo: `id:${actionItem.source.repoId}`, ...exact },
          options
        )
      )
        .then((response) => {
          if (stale || !canPublish()) {
            return
          }
          setItemAvailableLabels(githubRepoLabelListRead.interpret(response))
        })
        .catch((err) => {
          if (!stale && canPublish()) {
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

    if (wantsUsers) {
      setItemAssignableUsers([])
      setItemAssignableUsersError('')
      setItemAssignableUsersLoading(true)
      void loadRepositoryList((selected, exact, options) =>
        githubAssignableUserListRead.request(
          selected,
          { repo: `id:${actionItem.source.repoId}`, ...exact },
          options
        )
      )
        .then((response) => {
          if (stale || !canPublish()) {
            return
          }
          setItemAssignableUsers(githubAssignableUserListRead.interpret(response))
        })
        .catch((err) => {
          if (!stale && canPublish()) {
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
    }

    return () => {
      stale = true
    }
  }, [actionItem, client, tasksSupported, claimPublication])
  return model
}

export type ItemDetailMetadataEffectsModel = ListAndDetailEffectsModel &
  ReturnType<typeof useMobileTasksItemDetailMetadataEffects>
