// Answers to an agent's approvals and questions, and its options.
import { defineMethod } from '../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  RespondParams,
  RespondToQuestionParams,
  SetOptionParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS = [
  defineMethod({
    name: 'agentSession.respondToApproval',
    permission: 'workspace',
    params: RespondParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).respondToPrompt(callerFor(ctx), {
        ...params,
        kind: 'approval'
      })
  }),
  defineMethod({
    name: 'agentSession.respondToQuestion',
    permission: 'workspace',
    params: RespondToQuestionParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).respondToPrompt(callerFor(ctx), {
        ...params,
        kind: 'question'
      })
  }),
  defineMethod({
    name: 'agentSession.setOption',
    permission: 'workspace',
    params: SetOptionParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).setOption(callerFor(ctx), params)
  })
]
