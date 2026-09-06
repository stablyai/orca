import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { SwitchProviderParams } from './structured-agent-session-schemas'
import {
  switchProviderFingerprintFields,
  switchProviderIntentFingerprintFields
} from '../../../native-chat/agent-session-wire/structured-agent-session-provider-switch'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'

export const STRUCTURED_AGENT_SESSION_SWITCH_PROVIDER_METHOD = defineMethod({
  name: 'agentSession.switchProvider',
  params: SwitchProviderParams,
  handler: async (params, ctx) => {
    requireStructuredCapability(ctx)
    await ensureHostInstalled(ctx)
    const host = requireHost(ctx)
    const tab = host
      .listSessionTabs()
      .find((entry) => entry.sessionId === params.envelope.sessionId)
    if (!tab) {
      return {
        ok: false,
        refusal: {
          code: 'agent_session_ownership_unknown',
          message: 'This host holds no attached session by that id.'
        }
      }
    }
    // The renderer can only name the switch it asked for; the resolved provider and account home
    // arrive here. Admit the client's intent, then restamp the envelope with what the host commits
    // so a retry that resolves a different account home cannot replay as the same operation.
    const intentConflict = agentSessionFingerprintConflict(
      params.envelope,
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.switchProvider',
        sessionId: params.envelope.sessionId,
        fields: switchProviderIntentFingerprintFields(params)
      })
    )
    if (intentConflict) {
      return { ok: false, refusal: intentConflict }
    }
    const intent = await ctx.runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: {
        sessionId: params.envelope.sessionId,
        clientOperationId: params.envelope.clientOperationId
      },
      worktree: `id:${tab.workspaceId}`,
      agent: params.agent
    })
    const switchParams = {
      agent: params.agent,
      provider: intent.provider,
      accountHome: intent.accountHome,
      ...(params.model ? { model: params.model } : {})
    }
    const result = await host.switchProvider(callerFor(ctx), {
      ...switchParams,
      envelope: {
        ...params.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.switchProvider',
          sessionId: params.envelope.sessionId,
          fields: switchProviderFingerprintFields(switchParams)
        })
      }
    })
    const currentTab = host.listSessionTabs().find((entry) => entry.sessionId === tab.sessionId)
    if (currentTab && (result.ok || currentTab.agent !== tab.agent)) {
      try {
        await ctx.runtime.publishStructuredAgentSessionTab({
          workspaceId: currentTab.workspaceId,
          sessionId: currentTab.sessionId,
          agent: currentTab.agent,
          activate: !result.ok || !result.replayed
        })
      } catch (error) {
        // The switch already committed; a lost tab publication is a reconciliation, not a failure.
        console.warn('[agent-session] switch committed before tab publication failed', error)
        return {
          ok: false,
          refusal: {
            code: 'agent_session_operation_unknown',
            message: 'The chat may have switched providers, but its tab could not be confirmed.'
          }
        }
      }
    }
    return result
  }
})
