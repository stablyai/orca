import { defineMethod } from '../core'
import { RewindFilesPreviewParams } from '../../../../shared/rpc-contract/agent-session-rewind-params'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost as requireSessionHost
} from './structured-agent-session-gate'
export const STRUCTURED_REWIND_FILE_METHODS = [
  defineMethod({
    name: 'agentSession.rewindFilesPreview',
    permission: 'workspace',
    params: RewindFilesPreviewParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      return requireSessionHost(ctx, params.sessionId).previewRewindFiles(params)
    }
  })
]
