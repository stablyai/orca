import { defineMethod } from '../core'
import { StopTerminalAgentForChatParams } from '../../../../shared/rpc-contract/structured-agent-session-stop-terminal-params'
import {
  requireStructuredCapability,
  requireStructuredCreateSupportAdmission
} from './structured-agent-session-gate'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

export const STRUCTURED_AGENT_SESSION_STOP_TERMINAL_AGENT_METHODS = [
  defineMethod({
    name: 'agentSession.stopTerminalAgentForChat',
    permission: 'workspace',
    requires: ['accounts'],
    params: StopTerminalAgentForChatParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      requireStructuredCreateSupportAdmission(ctx, params.agent)
      try {
        return await ctx.runtime.stopTerminalAgentForChat(params)
      } catch (error) {
        if (isAgentSessionRefusalError(error)) {
          return { ok: false as const, refusal: error.refusal }
        }
        throw error
      }
    }
  })
]
