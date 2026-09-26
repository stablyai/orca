import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type {
  AgentSessionOptionsReplacement,
  AgentSessionRecord
} from '../../shared/agent-session-record'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  if (record.lease.runtimeFence !== replacement.fence || record.lease.claimStatus !== 'live') {
    throw agentSessionRefusalError('agent_session_ownership_unknown', 'leaseMoved')
  }
  return { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
}
