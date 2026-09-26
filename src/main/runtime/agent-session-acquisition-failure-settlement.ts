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
import { assertFence, withLease } from './agent-session-lease-transitions'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

/**
 * How the failed attempt's provider process was accounted for.
 * - `exit-proven`: cleanup observed the whole tree gone.
 * - `root-exit-observed`: the owner root's exit was observed first-hand, so the
 *   identity this lease is keyed on is dead, but its descendants could not be
 *   verified. Releases the lease and says exactly that, claiming nothing more.
 * - `processless`: the attempt failed before a process existed.
 * - `unproven`: nothing about the process was observed. A recorded owner goes to recovery, which
 *   concludes about it; a reservation that recorded none is released, since the adapter already
 *   closed the stdio of anything it spawned.
 */
export type AgentSessionAcquisitionExitProof =
  | 'exit-proven'
  | 'root-exit-observed'
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
      ? withLease(record, {
          ...record.lease,
          handoffStage: 'recovering',
          handoffOperationId: null,
          lastRenewedAt: args.now
        })
      : withLease(record, {
          ...record.lease,
          runtimeFence: nextAgentSessionFence(record.lease),
          handoffStage: null,
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          lastRenewedAt: args.now,
          handoffOperationId: null,
          deathEvidence:
            args.exitProof === 'root-exit-observed'
              ? {
                  kind: 'exit-observed',
                  detail: 'the provider process exited; its descendants were not proven gone',
                  observedAt: args.now
                }
              : {
                  kind: 'exit-observed',
                  detail: 'post-acquisition cleanup proved no provider child remains',
                  observedAt: args.now
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
    return withLease(record, {
      ...record.lease,
      handoffStage: 'recovering',
      // The operation is durably settled failed below; a lease still naming it would
      // read as an in-flight transfer to every consumer that keys on the stage + id pair.
      handoffOperationId: null,
      lastRenewedAt: args.now
    })
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
    deathEvidence: acquisitionDeathEvidence(args.exitProof, args.now)
  })
}

/** Records only what was observed: never a tree claim the cleanup did not make, and nothing at all
 *  when nothing was. */
function acquisitionDeathEvidence(
  exitProof: AgentSessionAcquisitionExitProof,
  observedAt: number
): AgentSessionDeathEvidence | null {
  if (exitProof === 'unproven') {
    return null
  }
  if (exitProof === 'processless') {
    return { kind: 'pid-absent', detail: 'reservation failed before spawn', observedAt }
  }
  if (exitProof === 'root-exit-observed') {
    return {
      kind: 'exit-observed',
      detail: 'the provider process exited; its descendants were not proven gone',
      observedAt
    }
  }
  // Cleanup proved no child of this attempt remains; it may never have spawned.
  return {
    kind: 'exit-observed',
    detail: 'acquisition cleanup proved no provider child remains',
    observedAt
  }
}
