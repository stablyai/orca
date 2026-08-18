import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  adapterSupportsCreate,
  adapterSupportsRecord
} from './structured-agent-session-provider-support'

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
  return adapterSupportsCreate(adapter, location, agent)
}

export function adapterSupportsAgentSessionRecord(
  adapter: StructuredAgentSessionAdapter,
  record: AgentSessionRecord
): boolean {
  return adapterSupportsRecord(adapter, record)
}

export function structuredAgentSessionTabAgent(agent: string): 'claude' | 'codex' {
  return agent === 'claude' ? 'claude' : 'codex'
}
