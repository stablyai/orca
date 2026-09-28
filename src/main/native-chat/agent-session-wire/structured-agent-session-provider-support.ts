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
  if (adapter.supportsCreate) {
    return adapter.supportsCreate(location, agent)
  }
  if (agent !== 'codex') {
    return false
  }
  // Older Codex adapters exposed only location support; absence still fails closed here.
  return adapter.supportsLocation?.(location) ?? false
}

/** Honors declared gates while retaining legacy adapters whose acquire path is authoritative. */
export function adapterSupportsCreateIfDeclared(
  adapter: StructuredAgentSessionAdapter,
  location: AgentSessionExecutionLocation,
  agent: string
): boolean {
  if (!adapter.supportsCreate && !adapter.supportsLocation) {
    return true
  }
  return adapterSupportsCreate(adapter, location, agent)
}

export function adapterSupportsRecord(
  adapter: StructuredAgentSessionAdapter,
  record: AgentSessionRecord
): boolean {
  if (adapter.supportsCreate) {
    return adapter.supportsCreate(record.location, record.provider)
  }
  // Old Codex records stay readable unless the adapter explicitly rejects their location.
  return record.provider === 'codex' && (adapter.supportsLocation?.(record.location) ?? true)
}
