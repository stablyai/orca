// Offer goal controls only when options reports threadGoal; older hosts lack the method.

import { defineMethod } from '../../../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from '../creation/structured-agent-session-gate'
import { ThreadGoalParams } from '../../../../../../shared/rpc-contract/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-queued-edit-params'

export const STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS = [
  defineMethod({
    name: 'agentSession.threadGoal',
    permission: 'workspace',
    params: ThreadGoalParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).changeThreadGoal(callerFor(ctx), params)
  })
]
