// `agentSession.threadGoal` — set, pause, resume or clear the provider thread's goal.
//
// Additive: an older host answers `method_not_found`, and a client offers the controls only where
// `agentSession.options` reported `threadGoal`, so it never reaches a host that lacks this method.

import { defineMethod } from '../core'
import {
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { ThreadGoalParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS = [
  defineMethod({
    name: 'agentSession.threadGoal',
    params: ThreadGoalParams,
    handler: async (params, ctx) => requireHost(ctx).changeThreadGoal(callerFor(ctx), params)
  })
]
