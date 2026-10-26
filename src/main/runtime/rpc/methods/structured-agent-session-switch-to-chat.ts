// `agentSession.switchToChat` — a terminal's conversation moving into the chat that already holds
// it. The host resolves the record and starts its agent through the ordinary operation start, so the
// provider open imports the terminal's turns; success is that agent ready. A refusal leaves the
// terminal to the client. Gated per agent by `agent-session.structured.switch.v1:<agent>`.

import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { refuse } from '../../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredSessionHost
} from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_SWITCH_TO_CHAT_METHODS = [
  defineMethod({
    name: 'agentSession.switchToChat',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (
      params,
      ctx
    ): Promise<
      { ok: true; sessionId: string } | { ok: false; refusal: AgentSessionWireRefusal }
    > => {
      requireStructuredCapability(ctx)
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
      return started.ok ? { ok: true, sessionId: params.sessionId } : started
    }
  })
]
