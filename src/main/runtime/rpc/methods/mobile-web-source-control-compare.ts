import { defineMethod } from '../core'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import {
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema
} from '../../../../shared/mobile-web/source-control-history-contract'
import {
  projectMobileWebBranchCompare,
  projectMobileWebCommitCompare
} from './mobile-web-source-control-compare-projection'

export const MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.branchCompare',
    params: MobileWebWorktreeScope.extend({ baseRef: MobileWebGitRefNameSchema }),
    handler: async (params, { runtime }) =>
      projectMobileWebBranchCompare(
        await runtime.getRuntimeGitBranchCompare(params.worktree, params.baseRef),
        params.baseRef
      )
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.commitCompare',
    params: MobileWebWorktreeScope.extend({ commitId: MobileWebGitObjectIdSchema }),
    handler: async (params, { runtime }) =>
      projectMobileWebCommitCompare(
        await runtime.getRuntimeGitCommitCompare(params.worktree, params.commitId),
        params.commitId
      )
  })
]
