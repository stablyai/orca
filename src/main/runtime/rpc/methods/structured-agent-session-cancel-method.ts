import { defineMethod } from '../core'
import { assertBotGroupSessionAccess } from '../../../bots/bot-group-session-access'
import { CancelParams } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  requireStructuredCleanupHost,
  structuredCallerFor as callerFor
} from './structured-sessions/creation/structured-agent-session-gate'

/** Stops a session's turn; a bot group's member session only for a caller in its group. */
export const STRUCTURED_AGENT_SESSION_CANCEL_METHOD = defineMethod({
  name: 'agentSession.cancel',
  permission: 'workspace',
  params: CancelParams,
  handler: async (params, ctx) => {
    assertBotGroupSessionAccess(ctx.runtime, params.envelope.sessionId)
    return requireStructuredCleanupHost(ctx).cancel(callerFor(ctx), params)
  }
})
