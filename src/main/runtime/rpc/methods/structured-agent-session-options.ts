// `agentSession.options`, `agentSession.commands`, `agentSession.setOption` — the
// per-session option surface.
//
// All three are thin pass-throughs to the executing host, which owns the option
// record and the provider's command list; nothing here interprets either.

import { defineMethod } from '../core'
import {
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { OptionsParams, SetOptionParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_OPTION_METHODS = [
  defineMethod({
    name: 'agentSession.setOption',
    params: SetOptionParams,
    handler: async (params, ctx) => requireHost(ctx).setOption(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.options',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx).readOptions(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx).readCommands(params.sessionId)
  })
]
