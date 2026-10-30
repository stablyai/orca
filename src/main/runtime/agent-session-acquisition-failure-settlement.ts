import {
  agentSessionOperationKey,
  settleAgentSessionOperation,
  type AgentSessionOperationOutcome
} from '../../shared/agent-session-operation-ledger'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type {
  AgentSessionDeathEvidence,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { assertFence, withLease } from './agent-session/ownership/agent-session-lease-transitions'
import type { AgentSessionStoreState } from './agent-session-store-state'

/** Cleanup evidence: exit-proven follows provider tree-close proof (Windows may use stdin EOF/root exit or taskkill /T).
 * root-exit-observed proves only the lease root died; processless means no process existed.
 * unproven sends recorded owners to recovery; ownerless reservations release after adapter stdio cleanup. */
export type AgentSessionAcquisitionExitProof =
  | 'exit-proven'
  | 'root-exit-observed'
  | 'kill-delivered'
  | 'processless'
  | 'unproven'

export type AgentSessionFailedAcquisitionSettlement = {
  sessionId: string
  fence: number
  spawnToken: string
  callerKey: string
  operationId: string
  outcome: Extract<AgentSessionOperationOutcome, { status: 'failed' }>
  exitProof: AgentSessionAcquisitionExitProof
  now: number
}

export type AgentSessionFailedPostAcquisitionAttachmentSettlement =
  AgentSessionFailedAcquisitionSettlement

/** Settled attaches must not strand reservations in new-owner-proving. */
export function settleFailedAgentSessionAcquisition(
  state: AgentSessionStoreState,
  args: AgentSessionFailedAcquisitionSettlement
): AgentSessionRecord {
  const operation = state.operations.get(agentSessionOperationKey(args.callerKey, args.operationId))
  if (!operation || operation.outcome.status !== 'pending') {
    throw new Error('agent_session_operation_conflict')
  }
  const record = state.records.get(args.sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const next = settleFailedLease(record, args)
  state.records.set(args.sessionId, next)
  state.operations = settleAgentSessionOperation(state.operations, args)
  return next
}

/** Native-owner proof still needs journal attachment before publication. */
export function settleFailedAgentSessionPostAcquisitionAttachment(
  state: AgentSessionStoreState,
  args: AgentSessionFailedPostAcquisitionAttachmentSettlement
): AgentSessionRecord {
  const operation = state.operations.get(agentSessionOperationKey(args.callerKey, args.operationId))
  if (!operation || operation.outcome.status !== 'pending') {
    throw new Error('agent_session_operation_conflict')
  }
  const record = state.records.get(args.sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  assertFence(record.lease, args.fence)
  if (
    record.lease.claimStatus !== 'live' ||
    record.lease.handoffStage !== null ||
    record.lease.ownerProcess?.spawnToken !== args.spawnToken ||
    record.lease.reservedSpawnToken !== args.spawnToken
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  const next =
    args.exitProof === 'unproven'
      ? {
          ...withLease(record, {
            ...record.lease,
            handoffStage: 'recovering',
            handoffOperationId: null
          }),
          updatedAt: args.now
        }
      : withLease(record, {
          ...record.lease,
          runtimeFence: nextAgentSessionFence(record.lease),
          handoffStage: null,
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          lastRenewedAt: args.now,
          handoffOperationId: null,
          deathEvidence: {
            kind: args.exitProof === 'kill-delivered' ? 'kill-delivered' : 'exit-observed',
            detail:
              args.exitProof === 'root-exit-observed'
                ? 'the provider process exited; its descendants were not proven gone'
                : 'post-acquisition cleanup proved no provider child remains',
            observedAt: args.now,
            ownerFence: record.lease.runtimeFence
          }
        })
  state.records.set(args.sessionId, next)
  state.operations = settleAgentSessionOperation(state.operations, args)
  return next
}

function settleFailedLease(
  record: AgentSessionRecord,
  args: AgentSessionFailedAcquisitionSettlement
): AgentSessionRecord {
  assertFence(record.lease, args.fence)
  if (
    record.lease.claimStatus !== 'reserved' ||
    record.lease.handoffStage !== 'new-owner-proving' ||
    record.lease.reservedSpawnToken !== args.spawnToken ||
    record.lease.handoffOperationId !== args.operationId
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (args.exitProof === 'unproven' && record.lease.ownerProcess) {
    // Recovery is not liveness proof; retain the spawn's last renewal.
    return {
      ...withLease(record, {
        ...record.lease,
        handoffStage: 'recovering',
        // Settlement ends the operation; clear its id so stage/id readers cannot mistake it for an in-flight transfer.
        handoffOperationId: null
      }),
      updatedAt: args.now
    }
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: nextAgentSessionFence(record.lease),
    handoffStage: null,
    ownerProcess: null,
    reservedSpawnToken: null,
    claimStatus: 'released',
    lastRenewedAt: args.now,
    handoffOperationId: null,
    deathEvidence: acquisitionDeathEvidence(args.exitProof, args.now, record.lease.runtimeFence)
  })
}

/** Record only cleanup evidence actually observed; never upgrade root exit into tree death. */
function acquisitionDeathEvidence(
  exitProof: AgentSessionAcquisitionExitProof,
  observedAt: number,
  ownerFence: number
): AgentSessionDeathEvidence | null {
  if (exitProof === 'unproven') {
    return null
  }
  const proof = { observedAt, ownerFence }
  if (exitProof === 'processless') {
    return { kind: 'pid-absent', detail: 'reservation failed before spawn', ...proof }
  }
  if (exitProof === 'kill-delivered') {
    return {
      kind: 'kill-delivered',
      detail: 'termination reached the conversation writer',
      ...proof
    }
  }
  if (exitProof === 'root-exit-observed') {
    return {
      kind: 'exit-observed',
      detail: 'the provider process exited; its descendants were not proven gone',
      ...proof
    }
  }
  // Cleanup proved no attempt child remains, including attempts that never spawned.
  return {
    kind: 'exit-observed',
    detail: 'acquisition cleanup proved no provider child remains',
    ...proof
  }
}
