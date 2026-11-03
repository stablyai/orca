import { useCallback, useMemo } from 'react'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { GitLabItemDialogView } from './gitlab-item-dialog/gitlab-item-dialog-view'
import type {
  GitLabDialogRepoSelector,
  GitLabItemDialogProps
} from './gitlab-item-dialog/gitlab-item-dialog-types'
import { useGitLabDetailsEditing } from './gitlab-item-dialog/use-gitlab-details-editing'
import {
  useGitLabItemDetailsEffect,
  useGitLabItemScopeResetEffect
} from './gitlab-item-dialog/use-gitlab-item-dialog-effects'
import { useGitLabItemDialogState } from './gitlab-item-dialog/use-gitlab-item-dialog-state'
import { useGitLabPipelineActions } from './gitlab-item-dialog/use-gitlab-pipeline-actions'
import { useGitLabPrimaryActions } from './gitlab-item-dialog/use-gitlab-primary-actions'
import { useGitLabReviewActions } from './gitlab-item-dialog/use-gitlab-review-actions'

export default function GitLabItemDialog({
  item,
  repoPath,
  repoId,
  sourceContext,
  onClose,
  onCreateWorkspace
}: GitLabItemDialogProps) {
  const itemId = item?.id ?? null
  // Why: one owner for provider-scoped state — the target the selector routes to (task source, GitLab
  // project, item and repo); a provider id or IID alone repeats across sources and instances.
  const detailsOwner = item
    ? [
        sourceContext ? getTaskSourceCacheScope(sourceContext) : '',
        item.projectRef ? `${item.projectRef.host}/${item.projectRef.path}` : '',
        item.type,
        item.number,
        itemId,
        item.repoHostId ?? '',
        repoId ?? '',
        repoPath ?? ''
      ].join('\0')
    : null
  const state = useGitLabItemDialogState(itemId, detailsOwner)
  const { setRefreshNonce } = state
  const repoSelector = useMemo<GitLabDialogRepoSelector | null>(() => {
    if (!repoPath) {
      return null
    }
    return {
      repoPath,
      ...(repoId ? { repoId } : {}),
      ...(sourceContext ? { sourceContext } : {})
    }
  }, [repoId, repoPath, sourceContext])
  const updateCommentDraft = state.updateCommentDraft

  useGitLabItemDetailsEffect(item, repoSelector, state)
  useGitLabItemScopeResetEffect(detailsOwner, state)

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [setRefreshNonce])
  const detailsEditing = useGitLabDetailsEditing(item, repoSelector, state, handleRefresh)
  const pipelineActions = useGitLabPipelineActions(item, repoSelector, state, handleRefresh)
  const reviewActions = useGitLabReviewActions(item, repoSelector, state, handleRefresh)
  const primaryActions = useGitLabPrimaryActions(item, itemId, repoSelector, state, handleRefresh)

  return (
    <GitLabItemDialogView
      item={item}
      onClose={onClose}
      onCreateWorkspace={onCreateWorkspace}
      state={state}
      detailsEditing={detailsEditing}
      pipelineActions={pipelineActions}
      primaryActions={primaryActions}
      reviewActions={reviewActions}
      handleRefresh={handleRefresh}
      updateCommentDraft={updateCommentDraft}
    />
  )
}
