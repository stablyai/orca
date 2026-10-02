import {
  agentSessionOperationKey,
  settleAgentSessionOperation,
  type AgentSessionOperationOutcome
} from '../../shared/agent-session-operation-ledger'
import {
  failedAcquisitionDeathEvidence,
  failedAcquisitionReleasesReservation,
  isFailedAcquisitionReservation,
  type AgentSessionAcquisitionExitProof
} from '../../shared/agent-session-failed-acquisition'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { assertFence, withLease } from './agent-session-lease-transitions'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

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

/** Liveness invariant: a settled attach never leaves its reservation in new-owner-proving. */
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

/** A proved native owner still is not publishable until its journal attaches. */
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
    record.lease.reservedSpawnToken !== args.spawnToken ||
    record.lease.provenHandleLinkId === null
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
            kind: 'exit-observed',
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
  if (!isFailedAcquisitionReservation(record.lease, args)) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (!failedAcquisitionReleasesReservation(record.lease, args.exitProof)) {
    // Parking in recovery proves nothing alive, so `lastRenewedAt` keeps the spawn's proof.
    return {
      ...withLease(record, {
        ...record.lease,
        handoffStage: 'recovering',
        // The operation is durably settled failed below; a lease still naming it would
        // read as an in-flight transfer to every consumer that keys on the stage + id pair.
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
    deathEvidence: failedAcquisitionDeathEvidence(
      args.exitProof,
      args.now,
      record.lease.runtimeFence
    )
  })
}
