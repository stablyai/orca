import { CancelUsageLimitContinueParams } from '../../../../shared/rpc-contract/usage-limit-continue-params'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_USAGE_LIMIT_CONTINUE_METHODS = [
  defineMethod({
    name: 'agentSession.cancelUsageLimitContinue',
    permission: 'workspace',
    params: CancelUsageLimitContinueParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      await host.usageLimitContinue.cancel(params)
      return { ok: true as const }
    }
  })
]
