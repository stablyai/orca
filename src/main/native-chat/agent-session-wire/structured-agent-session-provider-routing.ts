import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: 'claude' | 'codex'
}

export function adapterSupportsAgentSessionCreate(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  return (
    adapter.supportsCreate?.(location, agent) ??
    (agent === 'codex' && (adapter.supportsLocation?.(location) ?? false))
  )
}

export function adapterSupportsAgentSessionRecord(
  adapter: StructuredAgentSessionAdapter,
  record: AgentSessionRecord
): boolean {
  return adapter.supportsCreate
    ? adapter.supportsCreate(record.location, record.provider)
    : record.provider === 'codex'
}

export function structuredAgentSessionTabAgent(agent: string): 'claude' | 'codex' {
  return agent === 'claude' ? 'claude' : 'codex'
}
