import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import type { AgentSessionSwitchResult } from '../../../../shared/agent-session-switch-execution'
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { refuse } from '../../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost
} from './structured-agent-session-gate'
import { SwitchToChatParams } from './structured-agent-session-schemas'

// Optional execution uses the complete switch contract; strict legacy calls keep their envelope.

export const STRUCTURED_AGENT_SESSION_SWITCH_TO_CHAT_METHODS = [
  defineMethod({
    name: 'agentSession.switchToChat',
    permission: 'workspace',
    params: SwitchToChatParams,
    handler: async (
      params,
      ctx
    ): Promise<
      | { ok: true; sessionId: string }
      | { ok: false; refusal: AgentSessionWireRefusal }
      | AgentSessionSwitchResult
    > => {
      requireStructuredCapability(ctx)
      if (params.execution) {
        return executeStructuredSessionSwitch(params, ctx, 'chat')
      }
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredSessionHost(ctx, params.sessionId)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record || !inPlaceSwitchEnabled(record.provider)) {
        return {
          ok: false,
          refusal: refuse(
            'structured_agent_session_unsupported',
            { reason: 'hostUnsupported' },
            'This chat cannot take its conversation from a terminal on this host.'
          )
        }
      }
      const started = await host.switchToChat(params.sessionId)
      return started.ok
        ? { ok: true, sessionId: params.sessionId }
        : { ok: false, refusal: started.refusal }
    }
  })
]
