// `agentSession.agents` — the structured agents this host registered, with each agent's declared
// capability record, so a client can show what an agent supports before a session of it exists.
//
// Additive and negotiated: a client calls it only once the host advertises
// `agent-session.structured.registered-agents.v1`; without it, a client knows Claude and Codex only.

import type { AgentSessionAgentsResult } from '../../../../shared/agent-session-registered-agents'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../../shared/agent-session-registered-agents'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../../structured-agent-runtime-registrations'
import { defineMethod } from '../core'
import { requireStructuredCapability } from './structured-agent-session-gate'
import { AgentsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_AGENTS_METHODS = [
  defineMethod({
    name: AGENT_SESSION_AGENTS_METHOD,
    params: AgentsParams,
    // Read from the registrations the host is built from, as createSupport is: the answer is
    // fixed for this build, so it never waits on, or fails with, installing the host.
    handler: async (_params, ctx): Promise<AgentSessionAgentsResult> => {
      requireStructuredCapability(ctx)
      return {
        agents: STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => ({
          agent: definition.agent,
          capabilities: { ...definition.capabilities }
        }))
      }
    }
  })
]
