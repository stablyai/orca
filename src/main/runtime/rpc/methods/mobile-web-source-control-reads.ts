import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlStatusPayloadSchema
} from '../../../../shared/mobile-web/source-control-operation-contract'
import {
  projectMobileWebSourceControlDiff,
  projectMobileWebSourceControlStatus
} from '../../../../shared/mobile-web/source-control-host-presentation'
import {
  clipMobileWebDiffResult,
  MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES
} from './mobile-web-source-control-diff-clip'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

export const MOBILE_WEB_SOURCE_CONTROL_READ_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.status',
    params: MobileWebSourceControlStatusPayloadSchema.omit({ workspaceId: true }).extend(
      MobileWebWorktreeScope.shape
    ),
    handler: async (params, context) => {
      const raw = await context.runtime.getRuntimeGitStatus(params.worktree, {
        reuseLineStats: true,
        admissionTier: 'status',
        ...(context.signal ? { signal: context.signal } : {})
      })
      const result = withoutMobileWebWorkspaceId(
        projectMobileWebSourceControlStatus(raw, MOBILE_WEB_PAGE_IDENTITY, params.limit)
      )
      while (
        Buffer.byteLength(JSON.stringify(result)) > MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES &&
        result.entries.length
      ) {
        result.entries.pop()
        result.truncated = true
      }
      return result
    }
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.diff',
    params: MobileWebSourceControlDiffPayloadSchema.omit({ workspaceId: true }).extend(
      MobileWebWorktreeScope.shape
    ),
    handler: async (params, context) => {
      const raw = await context.runtime.getRuntimeGitDiff(
        params.worktree,
        params.relativePath,
        params.area === 'staged'
      )
      return clipMobileWebDiffResult(
        withoutMobileWebWorkspaceId(
          projectMobileWebSourceControlDiff(raw, {
            ...params,
            workspaceId: MOBILE_WEB_PAGE_IDENTITY
          })
        )
      )
    }
  })
]
