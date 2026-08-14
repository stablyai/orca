import {
  isAgentSessionOptions,
  type AgentSessionOptionsReplacement,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  if (record.lease.runtimeFence !== replacement.fence || record.lease.claimStatus !== 'live') {
    throw new Error('agent_session_ownership_unknown')
  }
  if (!isAgentSessionOptions(replacement.options)) {
    throw new Error('agent_session_options_invalid')
  }
  return { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
}
