import { defineMethod } from '../core'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import { MobileWebSourceControlReviewLinkUpdatePayloadSchema } from '../../../../shared/mobile-web/source-control-review-contract'
import {
  mobileWebReviewLinkWorktreeField,
  projectMobileWebReviewLink
} from './mobile-web-source-control-review-projection'

const UpdateParams = MobileWebWorktreeScope.extend(
  MobileWebSourceControlReviewLinkUpdatePayloadSchema.omit({ workspaceId: true }).shape
)

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewLink',
    params: MobileWebWorktreeScope,
    handler: async (params, { runtime }) =>
      projectMobileWebReviewLink(await runtime.showManagedWorktree(params.worktree))
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewLinkUpdate',
    params: UpdateParams,
    handler: async (params, { runtime }) => {
      await runtime.updateManagedWorktreeMeta(params.worktree, {
        ...mobileWebReviewLinkWorktreeField(params.provider, params.number),
        ...(params.baseRef ? { baseRef: params.baseRef } : {})
      })
      return projectMobileWebReviewLink(await runtime.showManagedWorktree(params.worktree))
    }
  })
]
