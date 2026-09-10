import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  /** Provider's conversation name; absent until one exists, so the caller keeps its placeholder. */
  title?: string
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >,
  getRecord: (sessionId: string) => AgentSessionRecord | null = () => null
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => {
    const title = getRecord(sessionId)?.conversationName
    return {
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: session.params.provider,
      ...(title ? { title } : {})
    }
  })
}
