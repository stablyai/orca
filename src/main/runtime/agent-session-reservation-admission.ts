/**
 * Reservation admission: what a reserve request means against the persisted state.
 *
 * Pure over a store snapshot so the compare-and-swap, the idempotency replay, and the
 * location-immutability check can be reasoned about without touching the disk. The store applies
 * the result inside one transaction; nothing here mutates.
 */

import {
  evaluateAgentSessionOperation,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import {
  AGENT_SESSION_EFFECT_ISOLATED_RECORD_SCHEMA_VERSION,
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  agentSessionExecutionLocationsEqual,
  isAgentSessionLaunchEnv,
  type AgentSessionAccountHome,
  type AgentSessionEffectIsolation,
  type AgentSessionExecutionLocation,
  type AgentSessionLaunchEnv,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import {
  reserveAgentSessionOwner,
  type AgentSessionReservation
} from './agent-session-lease-transitions'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

export type AgentSessionReserveRequest = {
  sessionId: string
  location: AgentSessionExecutionLocation
  provider: AgentSessionHandleProvider
  accountHome: AgentSessionAccountHome
  effectIsolation?: AgentSessionEffectIsolation
  launchEnv?: AgentSessionLaunchEnv
  runtimeKind: AgentSessionReservation['runtimeKind']
  /** Null when the session does not exist yet; otherwise the fence the caller last observed. */
  expectedFence: number | null
  spawnToken: string
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
    // Why: the recorded effect is no longer reconstructable, and re-running it would be a second
    // spawn rather than a replay.
    throw new Error('agent_session_ownership_unknown')
  }
  return record
}

export function applyAgentSessionReservation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  leaseTtlMs: number
): {
  record: AgentSessionRecord
  disposition: Exclude<AgentSessionReserveDisposition, 'replayed'>
} {
  if (request.launchEnv && !isAgentSessionLaunchEnv(request.launchEnv)) {
    throw new Error('agent_session_launch_env_invalid')
  }
  if (
    request.effectIsolation &&
    (request.provider !== 'codex' ||
      request.accountHome.variable !== 'CODEX_HOME' ||
      request.runtimeKind !== 'native')
  ) {
    throw new Error('agent_session_operation_invalid')
  }
  const reservation: AgentSessionReservation = {
    runtimeKind: request.runtimeKind,
    spawnToken: request.spawnToken,
    claimKeyId: request.claimKeyId,
    handoffOperationId: request.handoffOperationId,
    leaseTtlMs: request.leaseTtlMs ?? leaseTtlMs,
    now: request.now
  }
  const existing = state.records.get(request.sessionId)
  if (!existing) {
    if (state.unreadableRecords.has(request.sessionId)) {
      throw new Error('execution_owner_reconciling')
    }
    if (request.expectedFence !== null) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { record: createAgentSessionRecord(request, reservation), disposition: 'created' }
  }
  if (
    !agentSessionExecutionLocationsEqual(existing.location, request.location) ||
    existing.provider !== request.provider ||
    existing.accountHome.variable !== request.accountHome.variable ||
    existing.accountHome.path !== request.accountHome.path ||
    existing.effectIsolation !== request.effectIsolation
  ) {
    // Why: location, provider, and account are the session identity; changing one is a fork.
    throw new Error('agent_session_conflict')
  }
  if (request.expectedFence === null) {
    throw new Error('agent_session_conflict')
  }
  const pinned =
    existing.launchEnv || !request.launchEnv
      ? existing
      : { ...existing, launchEnv: { ...request.launchEnv }, updatedAt: request.now }
  return reserveAgentSessionOwner({
    record: pinned,
    expectedFence: request.expectedFence,
    probe: request.probe,
    reservation
  })
}

function createAgentSessionRecord(
  request: AgentSessionReserveRequest,
  reservation: AgentSessionReservation
): AgentSessionRecord {
  return {
    schemaVersion: request.effectIsolation
      ? AGENT_SESSION_EFFECT_ISOLATED_RECORD_SCHEMA_VERSION
      : AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: request.sessionId,
    location: request.location,
    provider: request.provider,
    providerHandleChain: [],
    accountHome: request.accountHome,
    ...(request.effectIsolation ? { effectIsolation: request.effectIsolation } : {}),
    ...(request.launchEnv ? { launchEnv: { ...request.launchEnv } } : {}),
    createdAt: request.now,
    updatedAt: request.now,
    lease: {
      sessionId: request.sessionId,
      runtimeKind: reservation.runtimeKind,
      // Why: fence 1 is the first reservation; 0 is reserved for "no owner has ever existed".
      runtimeFence: 1,
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: reservation.spawnToken,
      leaseDeadlineAt: reservation.now + reservation.leaseTtlMs,
      lastRenewedAt: reservation.now,
      handoffOperationId: reservation.handoffOperationId,
      journalCheckpoint: null,
      claimKeyId: reservation.claimKeyId,
      claimStatus: 'reserved',
      unreconciled: false,
      deathEvidence: null
    }
  }
}
