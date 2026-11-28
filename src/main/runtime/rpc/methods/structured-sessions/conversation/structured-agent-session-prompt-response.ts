import { botOfHomeWorkspace } from '../../../../../../shared/bots/bot-homes'
import { selectBotProviderFromComposer } from '../../../../../bots/bot-composer-provider-switch'
import { defineMethod } from '../../../core'
import { clientReadsOptionsWithoutModel } from '../structured-agent-session-policy'
import { isAgentRpcCaller } from '../../../callers/rpc-caller-identity'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience,
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from '../creation/structured-agent-session-gate'
import {
  RespondParams,
  SelectProviderParams,
  SetOptionParams
} from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-rename-params'
import '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-queued-edit-params'
import { RespondToQuestionParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-question-params'

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
  }),
  defineMethod({
    name: 'agentSession.selectProvider',
    permission: 'workspace',
    params: SelectProviderParams,
    handler: async (params, ctx) => {
      if (ctx.plugin || !ctx.caller || isAgentRpcCaller(ctx.caller)) {
        throw new Error('forbidden')
      }
      requireStructuredAgentAudience(ctx, params.agent)
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const record = host.deps.store.getConversation(params.sessionId)
      const bot = record
        ? botOfHomeWorkspace(ctx.runtime.bots.list(), record.location.workspaceId)
        : null
      if (bot) {
        return selectBotProviderFromComposer(ctx.runtime, host, bot, params)
      }
      return host.selectProvider(params)
    }
  })
]
