// `agentSession.agents` — the structured agents this host registered, with each agent's declared
// capability record, so a client can show what an agent supports before a session of it exists.
//
// Additive and negotiated: a client calls it only once the host advertises
// `agent-session.structured.registered-agents.v1`; without it, a client knows Claude and Codex only.

import type { AgentSessionAgentsResult } from '../../../../shared/agent-session-registered-agents'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../../shared/agent-session-registered-agents'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { AgentsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_AGENTS_METHODS = [
  defineMethod({
    name: AGENT_SESSION_AGENTS_METHOD,
    params: AgentsParams,
    handler: async (_params, ctx): Promise<AgentSessionAgentsResult> => ({
      agents: (await requireInstalledStructuredHost(ctx))
        .agentDefinitions()
        .map(({ agent, capabilities }) => ({ agent, capabilities: { ...capabilities } }))
    })
  })
]
