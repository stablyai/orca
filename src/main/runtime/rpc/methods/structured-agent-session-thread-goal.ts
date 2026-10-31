// Offer goal controls only when options reports threadGoal; older hosts lack the method.

import { defineMethod } from '../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { ThreadGoalParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS = [
  defineMethod({
    name: 'agentSession.threadGoal',
    permission: 'workspace',
    params: ThreadGoalParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).changeThreadGoal(callerFor(ctx), params)
  })
]
