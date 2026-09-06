import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentType } from '../../../shared/agent-status-types'

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentType
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    {
      params: {
        location: { workspaceId: string }
        provider: AgentSessionRecord['provider']
        agent: AgentType
      }
    }
  >
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.agent
  }))
}
