import { z } from 'zod'
import { defineMethod } from '../core'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import {
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT,
  MobileWebGitRefNameSchema
} from '../../../../shared/mobile-web/source-control-history-contract'
import {
  projectMobileWebBranches,
  projectMobileWebHistory
} from './mobile-web-source-control-history-projection'

export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.branches',
    params: MobileWebWorktreeScope,
    handler: async (params, { runtime }) =>
      projectMobileWebBranches(await runtime.listRuntimeGitLocalBranches(params.worktree))
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.history',
    params: MobileWebWorktreeScope.extend({
      limit: z
        .number()
        .int()
        .min(1)
        .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT)
        .default(MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT),
      baseRef: MobileWebGitRefNameSchema.optional()
    }),
    handler: async (params, { runtime }) =>
      projectMobileWebHistory(
        await runtime.getRuntimeGitHistory(params.worktree, {
          limit: params.limit,
          ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef })
        }),
        params.limit
      )
  })
]
