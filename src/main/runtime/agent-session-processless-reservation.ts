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
    throw new Error('agent_session_checkpoint_stale')
  }
  if (
    record.lease.claimStatus !== 'reserved' ||
    record.lease.reservedSpawnToken !== args.spawnToken
  ) {
    throw new Error('agent_session_ownership_unknown')
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
    throw new Error('agent_session_ownership_unknown')
  }
  return {
    ...record,
    lease: { ...record.lease, processlessAt: args.processlessAt },
    updatedAt: args.now
  }
}
