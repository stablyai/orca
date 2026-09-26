import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export type AgentSessionReservationProcesslessProof = {
  sessionId: string
  fence: number
  spawnToken: string
  now: number
}

function assertReservation(
  record: AgentSessionRecord,
  args: AgentSessionReservationProcesslessProof
): void {
  if (record.lease.runtimeFence !== args.fence || record.lease.unreconciled) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', 'leaseMoved')
  }
  if (
    record.lease.claimStatus !== 'reserved' ||
    record.lease.reservedSpawnToken !== args.spawnToken
  ) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', 'leaseMoved')
  }
}

export function setAgentSessionReservationProcesslessProof(
  args: AgentSessionReservationProcesslessProof & {
    record: AgentSessionRecord
    processlessAt: number | null
  }
): AgentSessionRecord {
  const { record } = args
  assertReservation(record, args)
  if (args.processlessAt === null && record.lease.processlessAt == null) {
    return record
  }
  if (record.lease.ownerProcess !== null) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', 'leaseMoved')
  }
  return {
    ...record,
    lease: { ...record.lease, processlessAt: args.processlessAt },
    updatedAt: args.now
  }
}
