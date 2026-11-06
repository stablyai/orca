import { defineMethod } from '../core'
import { requireStructuredSessionHost, structuredCallerFor } from './structured-agent-session-gate'
import { BackgroundTaskParams } from '../../../../shared/rpc-contract/structured-agent-session-background-params'

export const STRUCTURED_AGENT_SESSION_BACKGROUND_ACTION_METHOD = defineMethod({
  name: 'agentSession.backgroundTask',
  permission: 'workspace',
  params: BackgroundTaskParams,
  handler: async (params, ctx) =>
    requireStructuredSessionHost(ctx, params.envelope.sessionId).backgroundTask(
      structuredCallerFor(ctx),
      params
    )
})
