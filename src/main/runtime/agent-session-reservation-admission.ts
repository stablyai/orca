/**
 * Reservation admission: what a reserve request means against the persisted state.
 *
 * Pure over a store snapshot so the compare-and-swap, the idempotency replay, and the
 * location-immutability check can be reasoned about without touching the disk.
 *
 * `commitAgentSessionReservation` is the one exception and the only writer here: it sequences
 * those decisions and applies the winning one to the state it was handed. The store calls it
 * inside a transaction, which is what makes the record and its operation row land together.
 */

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  pendingAgentSessionOperationRow,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  agentSessionLeaseIsReleased,
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import {
  agentSessionExecutionLocationsEqual,
  isAgentSessionLaunchEnv,
  isAgentSessionOptions,
  type AgentSessionAccountHome,
  type AgentSessionExecutionLocation,
  type AgentSessionLaunchArgs,
  type AgentSessionLaunchEnv,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../shared/agent-session-launch-args'
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
  /** Arguments pinned on first reservation so owner replacement repeats the same launch. */
  launchArgs?: AgentSessionLaunchArgs
  /** Current launch input validated here but never written to the durable record. */
  launchEnv?: AgentSessionLaunchEnv
  /** Initial provider options persisted before the first process is acquired. */
  options?: Readonly<Record<string, string>>
  /** The fence of the record this start read. A record is founded by its create, never here. */
  expectedFence: number
  /** A supplier is invoked only when this operation wins a new reservation. */
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  operation: { callerKey: string; operationId: string; fingerprint: string }
  now: number
  leaseTtlMs?: number
}

export type AgentSessionReserveDisposition = 'reserved' | 'retry-reservation' | 'replayed'

export type AgentSessionReserveResult = {
  record: AgentSessionRecord
  disposition: AgentSessionReserveDisposition
  operationRow: AgentSessionOperationRow
}

export function evaluateAgentSessionReserveOperation(
  state: AgentSessionStoreState,
  request: Pick<AgentSessionReserveRequest, 'operation' | 'now'>
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
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.options && !isAgentSessionOptions(request.options)) {
    throw new Error('agent_session_options_invalid')
  }
  const reservation: AgentSessionReservation = {
    spawnToken:
      typeof request.spawnToken === 'function' ? request.spawnToken() : request.spawnToken,
    claimKeyId: request.claimKeyId,
    handoffOperationId: request.handoffOperationId,
    leaseTtlMs: request.leaseTtlMs ?? leaseTtlMs,
    now: request.now
  }
  const existing = state.records.get(request.sessionId)
  if (!existing) {
    throw state.unreadableRecords.has(request.sessionId)
      ? agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
      : agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'recordMissing' })
  }
  if (
    !agentSessionExecutionLocationsEqual(existing.location, request.location) ||
    existing.provider !== request.provider ||
    existing.accountHome.variable !== request.accountHome.variable ||
    existing.accountHome.path !== request.accountHome.path
  ) {
    // Why: location, provider, and account are the session identity; changing one is a fork.
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'identityMismatch' })
  }
  const pinned = {
    ...existing,
    ...(!existing.launchArgs && request.launchArgs ? { launchArgs: [...request.launchArgs] } : {}),
    ...(!existing.launchArgs && request.launchArgs ? { updatedAt: request.now } : {})
  }
  return reserveAgentSessionOwner({
    record: pinned,
    expectedFence: request.expectedFence,
    probe: request.probe,
    reservation
  })
}

/**
 * Compare-and-swap reservation plus its client-operation row, committed together. A replayed
 * operation returns the recorded outcome and never reaches the reservation.
 */
export function commitAgentSessionReservation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  leaseTtlMs: number
): AgentSessionReserveResult {
  const decision = evaluateAgentSessionReserveOperation(state, request)
  const existing = state.records.get(request.sessionId)
  // An unfinished operation whose reservation recovery released continues under its own id at the
  // next fence, as a resume does under a new id; the fence move stops the old spawn committing.
  const continued =
    existing && agentSessionLeaseIsReleased(existing.lease)
      ? { ...request, expectedFence: existing.lease.runtimeFence }
      : null
  if (decision.decision === 'refused') {
    // An aged-out row proves nothing more: a released reservation runs no effect.
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
