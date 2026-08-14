import { agentSessionRecordAgent } from '../../../shared/agent-session-record'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export function adapterSupportsCreate(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  return (
    adapter.supportsCreate?.(location, agent) ??
    (agent === 'codex' && (adapter.supportsLocation?.(location) ?? false))
  )
}

export function adapterSupportsRecord(
  adapter: StructuredAgentSessionAdapter,
  record: AgentSessionRecord
): boolean {
  return adapter.supportsCreate
    ? adapter.supportsCreate(record.location, agentSessionRecordAgent(record))
    : record.provider === 'codex'
}
