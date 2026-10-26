/** Evaluate reservation identity/replay/CAS without I/O; commit applies the winning record and operation row in one store transaction. */

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { assertAgentSessionOptionsAdmitted } from '../../agent-session-record-options'
import { chatAgentsShareConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  pendingAgentSessionOperationRow,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session-operation-ledger'
import {
  agentSessionLeaseIsReleased,
  agentSessionLeaseOwnerVerdict,
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../../../shared/agent-session-lease-adjudication'
import {
  agentSessionExecutionLocationsEqual,
  isAgentSessionLaunchEnv,
  isAgentSessionOptions,
  type AgentSessionExecutionLocation,
  type AgentSessionLaunchArgs,
  type AgentSessionLaunchEnv,
  type AgentSessionRecord
} from '../../../../shared/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../../../shared/agent-session-launch-args'
import { isAgentSessionSurfaceTabId } from '../../../../shared/agent-session-surface-tab-id'
import { agentSessionProviderHandleRoot } from '../../../../shared/agent-session-provider-handle-encoding'
import type {
  StructuredAgentId,
  AgentSessionProviderHandleLink
} from '../../../../shared/agent-session-provider-handle'
import {
  reserveAgentSessionOwner,
  type AgentSessionReservation
} from './agent-session-lease-transitions'
import type { AgentSessionStoreState } from '../../agent-session-store-state'
import { agentSessionRecordIdentityFields } from '../../agent-session-record-founding'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session-account-home'

export type AgentSessionReserveRequest = {
  /** Host-resolved floating directory committed with the first owner reservation. */
  launchDirectory?: string
  sessionId: string
  location: AgentSessionExecutionLocation
  provider: StructuredAgentId
  accountHome: AgentSessionAccountHome
  /** Arguments pinned on first reservation so owner replacement repeats the same launch. */
  launchArgs?: AgentSessionLaunchArgs
  /** Current launch input validated here but never written to the durable record. */
  launchEnv?: AgentSessionLaunchEnv
  /** Initial provider options persisted before the first process is acquired. */
  options?: Readonly<Record<string, string>>
  /** Saved catalog rows those options are admitted against; transient, never written. */
  models?: Parameters<typeof assertAgentSessionOptionsAdmitted>[1]
  /** Reserved tab ids are checked before spawn and claimed only when the tab publishes. */
  surfaceTabId?: string
  /** Seed an adopted handle to resume its conversation; absent means a fresh provider conversation. */
  adoptedHandleLink?: AgentSessionProviderHandleLink
  /** Null when the session does not exist yet; otherwise the fence the caller last observed. */
  expectedFence: number | null
  /** A supplier is invoked only when this operation wins a new reservation. */
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  operation: { callerKey: string; operationId: string; fingerprint: string }
  now: number
  leaseTtlMs?: number
}

export type AgentSessionReserveDisposition =
  | 'created'
  | 'reserved'
  | 'retry-reservation'
  | 'replayed'

export type AgentSessionReserveResult = {
  record: AgentSessionRecord
  disposition: AgentSessionReserveDisposition
  operationRow: AgentSessionOperationRow
}

export function evaluateAgentSessionReserveOperation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): AgentSessionOperationDecision {
  state.operations = pruneAgentSessionOperationRows(state.operations, request.now)
  return evaluateAgentSessionOperation({
    rows: state.operations,
    callerKey: request.operation.callerKey,
    operationId: request.operation.operationId,
    fingerprint: request.operation.fingerprint,
    now: request.now
  })
}

export function requireAgentSessionRecordForReplay(
  state: AgentSessionStoreState,
  row: AgentSessionOperationRow,
  sessionId: string
): AgentSessionRecord {
  const replayedId = row.outcome.status === 'succeeded' ? row.outcome.sessionId : sessionId
  const record = state.records.get(replayedId)
  if (!record) {
    // Missing recorded effects cannot be replayed; running again would spawn twice.
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'recordMissing' })
  }
  return record
}

export function admitPendingAgentSessionReservationReplay(
  record: AgentSessionRecord,
  request: AgentSessionReserveRequest
): AgentSessionRecord {
  const decision = evaluateAgentSessionAcquisition({
    lease: record.lease,
    expectedFence: record.lease.runtimeFence,
    handoffOperationId: request.handoffOperationId,
    probe: request.probe
  })
  if (decision.decision === 'refused') {
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision !== 'retry-reservation') {
    // A replay may continue only its still-present reservation.
    throw agentSessionRefusalError('agent_session_ownership_unknown', {
      reason: 'replaySuperseded'
    })
  }
  return record
}

export function validateAgentSessionReservationInput(request: AgentSessionReserveRequest): void {
  if (request.launchEnv && !isAgentSessionLaunchEnv(request.launchEnv)) {
    throw new Error('agent_session_launch_env_invalid')
  }
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.options && !isAgentSessionOptions(request.options)) {
    throw new Error('agent_session_options_invalid')
  }
  assertAgentSessionOptionsAdmitted(request.provider, request.models, request.options)
}

export function applyAgentSessionReservation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  leaseTtlMs: number
): {
  record: AgentSessionRecord
  disposition: Exclude<AgentSessionReserveDisposition, 'replayed'>
} {
  validateAgentSessionReservationInput(request)
  const reservation: AgentSessionReservation = {
    spawnToken:
      typeof request.spawnToken === 'function' ? request.spawnToken() : request.spawnToken,
    claimKeyId: request.claimKeyId,
    handoffOperationId: request.handoffOperationId,
    leaseTtlMs: request.leaseTtlMs ?? leaseTtlMs,
    now: request.now
  }
  // Check inside the transaction: concurrent adoptions mint different session ids, so CAS alone cannot prevent two writers on one provider conversation.
  assertAdoptedConversationUnowned(state, request)
  const existing = state.records.get(request.sessionId)
  if (!existing) {
    if (state.unreadableRecords.has(request.sessionId)) {
      throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
    }
    if (request.expectedFence !== null) {
      throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'recordMissing' })
    }
    assertReservedTabUnheld(state, request)
    return { record: createAgentSessionRecord(request, reservation), disposition: 'created' }
  }
  if (
    !agentSessionExecutionLocationsEqual(existing.location, request.location) ||
    existing.provider !== request.provider ||
    !agentSessionAccountHomesEqual(existing.accountHome, request.accountHome)
  ) {
    // Location/provider/account define identity; changing any would fork the session.
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'identityMismatch' })
  }
  // Recreate only never-bound conversations whose last attempt is proven gone.
  const recreatable =
    existing.providerHandleChain.length === 0 &&
    !request.adoptedHandleLink &&
    agentSessionLeaseOwnerVerdict(existing.lease) === 'exited'
  if (request.expectedFence === null && !recreatable) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  assertReservedTabUnheld(state, request)
  const pinned = {
    ...existing,
    ...(!existing.launchArgs && request.launchArgs ? { launchArgs: [...request.launchArgs] } : {}),
    ...(!existing.launchArgs && request.launchArgs ? { updatedAt: request.now } : {})
  }
  return reserveAgentSessionOwner({
    record: pinned,
    expectedFence: request.expectedFence ?? existing.lease.runtimeFence,
    probe: request.probe,
    reservation
  })
}

/** Refuse another record's current conversation, matching the pre-commit check.
 * Run inside the transaction: distinct adoption ids evade per-record CAS and providers may permit corrupting concurrent writers.
 * Self-exemption is not replay; the operation ledger resolves replay before this guard. */
export function assertAdoptedConversationUnowned(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): void {
  const adopted = request.adoptedHandleLink
  if (!adopted) {
    return
  }
  const root = agentSessionProviderHandleRoot(adopted.handle)
  for (const record of state.records.values()) {
    if (record.sessionId === request.sessionId) {
      continue
    }
    // Only the conversation a chat continues now: an earlier link no longer holds anything.
    const head = record.providerHandleChain.at(-1)
    const holdsSameConversation =
      !!head &&
      (agentSessionProviderHandleRoot(head.handle) === root ||
        // One id from two chat agents that open the same conversations (`opencode`, `opencode2`).
        (head.handle.transport === adopted.handle.transport &&
          head.handle.nativeId === adopted.handle.nativeId &&
          chatAgentsShareConversations(head.handle.agent, adopted.handle.agent)))
    if (holdsSameConversation) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere',
        owner: { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
      })
    }
  }
}

/** Check tab-id conflicts before spawn; claim only on publication so failed creates leave no restorable tab. */
export function assertReservedTabUnheld(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): void {
  if (request.surfaceTabId === undefined) {
    return
  }
  if (!isAgentSessionSurfaceTabId(request.surfaceTabId)) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const holder = state.sessionTabs?.sessionIdFor(request.surfaceTabId)
  if (holder !== undefined && holder !== request.sessionId) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'tabIdTaken' })
  }
}

function createAgentSessionRecord(
  request: AgentSessionReserveRequest,
  reservation: AgentSessionReservation
): AgentSessionRecord {
  return {
    ...agentSessionRecordIdentityFields(request, request.now),
    // Adopted head links must carry the first reservation's fence.
    providerHandleChain: request.adoptedHandleLink ? [request.adoptedHandleLink] : [],
    lease: {
      sessionId: request.sessionId,
      runtimeKind: 'native',
      // First reservation is fence 1; zero means no owner has ever existed.
      runtimeFence: 1,
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: reservation.spawnToken,
      leaseDeadlineAt: reservation.now + reservation.leaseTtlMs,
      lastRenewedAt: reservation.now,
      handoffOperationId: reservation.handoffOperationId,
      claimKeyId: reservation.claimKeyId,
      claimStatus: 'reserved',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

/** Commit reservation and operation row together; completed replays never reserve again. */
export function commitAgentSessionReservation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  leaseTtlMs: number
): AgentSessionReserveResult {
  const decision = evaluateAgentSessionReserveOperation(state, request)
  const existing = state.records.get(request.sessionId)
  // Released unfinished operations may continue at the next fence, blocking old spawns from committing.
  const continued =
    existing && agentSessionLeaseIsReleased(existing.lease)
      ? { ...request, expectedFence: existing.lease.runtimeFence }
      : null
  if (decision.decision === 'refused') {
    // Expired rows add no effect authority to a released reservation.
    if (decision.code !== 'agent_session_operation_expired' || !continued) {
      throw agentSessionRefusalError(decision.code, decision.details)
    }
    const row = pendingAgentSessionOperationRow({ ...request.operation, now: request.now })
    return reserveWithOperationRow(state, continued, row, leaseTtlMs)
  }
  if (decision.decision === 'replay') {
    const record = requireAgentSessionRecordForReplay(state, decision.row, request.sessionId)
    if (decision.row.outcome.status !== 'pending' || request.handoffOperationId === null) {
      return { record, disposition: 'replayed', operationRow: decision.row }
    }
    if (continued) {
      return reserveWithOperationRow(state, continued, decision.row, leaseTtlMs)
    }
    const retried = admitPendingAgentSessionReservationReplay(record, request)
    return { record: retried, disposition: 'replayed', operationRow: decision.row }
  }
  return reserveWithOperationRow(state, request, decision.row, leaseTtlMs)
}

function reserveWithOperationRow(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  row: AgentSessionOperationRow,
  leaseTtlMs: number
): AgentSessionReserveResult {
  const result = applyAgentSessionReservation(state, request, leaseTtlMs)
  state.operations.set(agentSessionOperationKey(row.callerKey, row.operationId), row)
  state.records.set(result.record.sessionId, result.record)
  return { ...result, operationRow: row }
}
