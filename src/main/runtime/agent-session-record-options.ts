import type {
  AgentSessionOptionsReplacement,
  AgentSessionRecord
} from '../../shared/agent-session-record'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  if (record.lease.runtimeFence !== replacement.fence || record.lease.claimStatus !== 'live') {
    throw new Error('agent_session_ownership_unknown')
  }
  return { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
}
