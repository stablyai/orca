import { defineMethod } from '../../../core'
import { clientReadsOptionsWithoutModel } from '../structured-agent-session-policy'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from '../creation/structured-agent-session-gate'
import {
  RespondParams,
  SetOptionParams
} from '../../../../../../shared/rpc-contract/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import { RespondToQuestionParams } from '../../../../../../shared/rpc-contract/structured-agent-session-question-params'

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
      requireSessionHost(ctx, params.envelope.sessionId).setOption(
        { ...callerFor(ctx), readsOptionsWithoutModel: clientReadsOptionsWithoutModel(ctx) },
        params
      )
  })
]
