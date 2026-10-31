import { isDeepStrictEqual } from 'node:util'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { agentSessionLeaseIsReleased } from '../../shared/agent-session-lease-adjudication'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { StructuredAgentSessionAcquisitionReceipt } from '../native-chat/agent-session-wire/structured-agent-session-startup-attempt-contract'
import { assertFence, withLease } from './agent-session/ownership/agent-session-lease-transitions'

/** An unpublished start's observed exit belongs to its reservation, never a later owner. */
export function recordAgentSessionAcquisitionExit(
  record: AgentSessionRecord,
  receipt: StructuredAgentSessionAcquisitionReceipt,
  expectedFence: number,
  now: number,
  deathEvidenceKind: 'exit-observed' | 'kill-delivered' = 'exit-observed'
): AgentSessionRecord {
  assertFence(record.lease, expectedFence)
  const lease = record.lease
  const released =
    agentSessionLeaseIsReleased(lease) &&
    lease.ownerProcess === null &&
    lease.runtimeFence === nextAgentSessionFence({ ...lease, runtimeFence: receipt.fence })
  const owner = lease.ownerProcess
  const recovering =
    lease.handoffStage === 'recovering' &&
    lease.handoffOperationId === null &&
    lease.runtimeFence === receipt.fence &&
    lease.reservedSpawnToken === receipt.spawnToken &&
    owner !== null &&
    receipt.process !== undefined &&
    isDeepStrictEqual({ ...owner, runtime: undefined }, { ...receipt.process, runtime: undefined })
  if (
    !agentSessionExecutionLocationsEqual(record.location, receipt.location) ||
    (!released && !recovering)
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...lease,
    runtimeFence: released ? lease.runtimeFence : nextAgentSessionFence(lease),
    ownerProcess: null,
    reservedSpawnToken: null,
    claimStatus: 'released',
    handoffStage: null,
    handoffOperationId: null,
    lastRenewedAt: now,
    deathEvidence: {
      kind: deathEvidenceKind,
      detail: 'the failed acquisition provider root exited',
      ownerFence: receipt.fence,
      observedAt: now
    }
  })
}
