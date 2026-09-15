/* Why: GitLab counterpart to GitHubItemDialog. Side sheet with three
   tabs (Description / Conversation / Pipeline) and footer actions —
   close/reopen, merge, and a top-level comment composer. Files /
   inline review-comment positioning / approvals are deferred to v1.5
   since they mirror substantial GitHub-side surface area. */
import { useCallback, useMemo } from 'react'
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
  const state = useGitLabItemDialogState(itemId)
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
  useGitLabItemScopeResetEffect(itemId, state)

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [setRefreshNonce])
  const detailsEditing = useGitLabDetailsEditing(item, repoSelector, state)
  const pipelineActions = useGitLabPipelineActions(item, repoSelector, state, handleRefresh)
  const reviewActions = useGitLabReviewActions(item, repoSelector, state)
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
