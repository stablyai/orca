import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlReviewDiffShape,
  rejectMissingReviewCompareIdentity
} from '../../../../shared/mobile-web/source-control-review-contract'
import { projectMobileWebSourceControlDiff } from '../../../../shared/mobile-web/source-control-host-presentation'
import { clipMobileWebDiffResult } from './mobile-web-source-control-diff-clip'

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewDiff',
    params: MobileWebWorktreeScope.extend(MobileWebSourceControlReviewDiffShape)
      .strict()
      .superRefine(rejectMissingReviewCompareIdentity),
    handler: async (params, context) => {
      const raw =
        params.scope === 'branch'
          ? await context.runtime.getRuntimeGitBranchDiff(
              params.worktree,
              params.compare!,
              params.relativePath,
              params.oldRelativePath
            )
          : await context.runtime.getRuntimeGitDiff(
              params.worktree,
              params.relativePath,
              params.scope === 'staged'
            )
      const {
        workspaceId: _workspaceId,
        area: _area,
        ...page
      } = projectMobileWebSourceControlDiff(raw, {
        workspaceId: MOBILE_WEB_PAGE_IDENTITY,
        relativePath: params.relativePath,
        area: params.scope === 'staged' ? 'staged' : 'unstaged',
        offset: params.offset,
        limit: params.limit,
        ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {})
      })
      return clipMobileWebDiffResult({ ...page, scope: params.scope })
    }
  })
]
