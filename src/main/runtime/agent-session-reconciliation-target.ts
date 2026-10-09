import { isDeepStrictEqual } from 'node:util'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'

export function assertAgentSessionProbedOwner(
  current: AgentSessionRecord,
  probedOwner: AgentSessionProcessIdentity | null | undefined
): void {
  if (probedOwner !== undefined && !isDeepStrictEqual(current.lease.ownerProcess, probedOwner)) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'leaseMoved' })
  }
}

export function agentSessionReconciliationTargetMatches(
  current: AgentSessionRecord,
  probed: AgentSessionRecord
): boolean {
  return isDeepStrictEqual(current, probed)
}
