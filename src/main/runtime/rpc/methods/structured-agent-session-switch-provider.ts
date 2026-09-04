import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { SwitchProviderParams } from './structured-agent-session-schemas'

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
    const intent = await ctx.runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: {
        sessionId: params.envelope.sessionId,
        clientOperationId: params.envelope.clientOperationId
      },
      worktree: `id:${tab.workspaceId}`,
      agent: params.agent
    })
    const result = await host.switchProvider(callerFor(ctx), {
      envelope: params.envelope,
      agent: params.agent,
      provider: intent.provider,
      accountHome: intent.accountHome,
      ...(params.model ? { model: params.model } : {})
    })
    const currentTab = host.listSessionTabs().find((entry) => entry.sessionId === tab.sessionId)
    if (currentTab && (result.ok || currentTab.agent !== tab.agent)) {
      await ctx.runtime.publishStructuredAgentSessionTab({
        workspaceId: currentTab.workspaceId,
        sessionId: currentTab.sessionId,
        agent: currentTab.agent,
        activate: !result.ok || !result.replayed
      })
    }
    return result
  }
})
