import { defineMethod } from '../core'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlReviewMetadataUpdateShape,
  rejectDuplicateReviewMetadataKeys
} from '../../../../shared/mobile-web/source-control-review-contract'
import {
  mobileWebReviewMetadataWorktreeFields,
  projectMobileWebReviewMetadata
} from './mobile-web-source-control-review-projection'

const UpdateParams = MobileWebWorktreeScope.extend(MobileWebSourceControlReviewMetadataUpdateShape)
  .strict()
  .superRefine(rejectDuplicateReviewMetadataKeys)

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewMetadata',
    params: MobileWebWorktreeScope,
    handler: async (params, { runtime }) =>
      projectMobileWebReviewMetadata(await runtime.showManagedWorktree(params.worktree))
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewMetadataUpdate',
    params: UpdateParams,
    handler: async (params, { runtime }) => {
      const current = projectMobileWebReviewMetadata(
        await runtime.showManagedWorktree(params.worktree)
      )
      if (current.revision !== params.expectedRevision) {
        throw new Error('conflict')
      }
      // The workspace record has no compare-and-set, so another writer can still win after this read.
      await runtime.updateManagedWorktreeMeta(
        params.worktree,
        mobileWebReviewMetadataWorktreeFields({
          worktreeId: worktreeIdFromSelector(params.worktree),
          comments: params.comments,
          reviewState: params.reviewState
        })
      )
      return projectMobileWebReviewMetadata(await runtime.showManagedWorktree(params.worktree))
    }
  })
]

function worktreeIdFromSelector(worktree: string): string {
  return worktree.startsWith('id:') ? worktree.slice('id:'.length) : worktree
}
