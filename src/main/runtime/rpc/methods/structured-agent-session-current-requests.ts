import { defineMethod } from '../core'
import type { RpcContext } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import {
  CurrentRequestsParams,
  CancelCurrentQuestionsParams
} from '../../../../shared/rpc-contract/agent-session-current-requests-params'
import {
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_V2
} from '../../../../shared/agent-session-current-requests-capability'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

export function clientReadsCurrentRequests(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return currentRequestsContract(context) !== undefined
}

export function currentRequestsContract(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
) {
  if (context.clientCapabilities?.includes(AGENT_SESSION_CURRENT_REQUESTS_V2)) {
    return AGENT_SESSION_CURRENT_REQUESTS_V2
  }
  return context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY)
    ? AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
    : undefined
}

export const STRUCTURED_AGENT_SESSION_CURRENT_REQUESTS_METHODS = [
  defineMethod({
    name: 'agentSession.cancelCurrentQuestions',
    permission: 'workspace',
    params: CancelCurrentQuestionsParams,
    handler: async (params, ctx) => {
      if (currentRequestsContract(ctx) !== AGENT_SESSION_CURRENT_REQUESTS_V2 || !ctx.caller) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      await host.cancelCurrentQuestions(params, rpcCallerOperationKey(ctx.caller))
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'agentSession.currentRequests',
    permission: 'workspace',
    params: CurrentRequestsParams,
    handler: async (params, ctx) => {
      if (!clientReadsCurrentRequests(ctx)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      return (await requireInstalledStructuredHost(ctx, params.sessionId)).readCurrentRequests(
        params,
        currentRequestsContract(ctx)
      )
    }
  })
]
