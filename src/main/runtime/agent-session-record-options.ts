import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  isAgentSessionOptions,
  type AgentSessionOptionsReplacement,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  const { lease } = record
  // At rest the host is the only writer: a pick is intent the next start replays.
  const atRest = lease.claimStatus === 'released' && lease.ownerProcess === null
  if (lease.runtimeFence !== replacement.fence || (lease.claimStatus !== 'live' && !atRest)) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  if (!isAgentSessionOptions(replacement.options)) {
    throw new Error('agent_session_options_invalid')
  }
  return { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
}
