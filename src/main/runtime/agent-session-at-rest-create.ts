// A chat's creation: its record at rest and the operation row that answers a retry of it, in one
// write. Nothing starts here; the chat's first message starts its agent, as /clear's new chat does.

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { agentSessionLeaseOwnerVerdict } from '../../shared/agent-session-lease-adjudication'
import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import {
  agentSessionExecutionLocationsEqual,
  isAgentSessionOptions,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../shared/agent-session-launch-args'
import { isAgentSessionSurfaceTabId } from '../../shared/agent-session-surface-tab-id'
import {
  agentSessionProviderHandleRoot,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import {
  foundAgentSessionRecord,
  type AgentSessionRecordIdentity
} from './agent-session-record-founding'
import {
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  type AgentSessionReserveRequest
} from './agent-session-reservation-admission'

export type AgentSessionAtRestCreateRequest = AgentSessionRecordIdentity &
  Pick<AgentSessionReserveRequest, 'claimKeyId' | 'operation' | 'now'> & {
    /** The tab id a create reserves for this conversation, taken when its tab is published. */
    surfaceTabId?: string
    /** The provider conversation this create adopts; its first start resumes it. */
    adoptedHandleLink?: AgentSessionProviderHandleLink
  }

export type AgentSessionAtRestCreateResult = {
  record: AgentSessionRecord
  /** Pending until the create's journal is open and any adopted history imported; a replay of a
   *  pending row does both again. */
  operationRow: AgentSessionOperationRow
  replayed: boolean
}

export function commitAgentSessionAtRestCreate(
  state: AgentSessionStoreState,
  request: AgentSessionAtRestCreateRequest
): AgentSessionAtRestCreateResult {
  const decision = evaluateAgentSessionReserveOperation(state, request)
  if (decision.decision === 'refused') {
    const existing = state.records.get(request.sessionId)
    // An aged-out row proves nothing more, and a create starts nothing: the chat it would answer
    // with is the record already here, under a fresh row the create settles as it would its own.
    if (
      decision.code === 'agent_session_operation_expired' &&
      existing &&
      sameCreate(existing, request)
    ) {
      return recordOperationRow(state, existing, request, true)
    }
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision === 'replay') {
    return {
      record: requireAgentSessionRecordForReplay(state, decision.row, request.sessionId),
      operationRow: decision.row,
      replayed: true
    }
  }
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.options && !isAgentSessionOptions(request.options)) {
    throw new Error('agent_session_options_invalid')
  }
  if (state.unreadableRecords.has(request.sessionId)) {
    throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
  }
  const existing = state.records.get(request.sessionId)
  if (existing && !refoundable(existing, request)) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  if (existing?.lease.unreconciled) {
    // This host has not adjudicated the lease since it loaded it: nothing proves its exit yet.
    throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'hostReconciling' })
  }
  assertAdoptedConversationUnowned(state, request)
  assertReservedTabUnheld(state, request)
  const founded = foundAgentSessionRecord(request, request, request.adoptedHandleLink)
  const record = existing ? refounded(existing, founded) : founded
  state.records.set(record.sessionId, record)
  return recordOperationRow(state, record, request, false)
}

function recordOperationRow(
  state: AgentSessionStoreState,
  record: AgentSessionRecord,
  request: AgentSessionAtRestCreateRequest,
  replayed: boolean
): AgentSessionAtRestCreateResult {
  const operationRow = pendingAgentSessionOperationRow({ ...request.operation, now: request.now })
  state.operations.set(
    agentSessionOperationKey(operationRow.callerKey, operationRow.operationId),
    operationRow
  )
  return { record, operationRow, replayed }
}

/** The record this create founded: same identity, and the conversation it adopted, if any. */
function sameCreate(existing: AgentSessionRecord, request: AgentSessionAtRestCreateRequest) {
  const adoptedRoot = request.adoptedHandleLink
    ? agentSessionProviderHandleRoot(request.adoptedHandleLink.handle)
    : null
  const heldAdoption = existing.providerHandleChain.find((link) => link.origin === 'adopted')
  return (
    sameIdentity(existing, request) &&
    (adoptedRoot === null
      ? heldAdoption === undefined
      : heldAdoption !== undefined &&
        agentSessionProviderHandleRoot(heldAdoption.handle) === adoptedRoot)
  )
}

function sameIdentity(existing: AgentSessionRecord, request: AgentSessionAtRestCreateRequest) {
  return (
    agentSessionExecutionLocationsEqual(existing.location, request.location) &&
    existing.provider === request.provider &&
    existing.accountHome.variable === request.accountHome.variable &&
    existing.accountHome.path === request.accountHome.path
  )
}

/**
 * A record a create may found again at rest: its agent never bound a conversation and its last
 * start is proven gone, so founding it again is founding it fresh. An older host left exactly this
 * when the start it ran at create failed, and the client's relaunch of that chat (same session id,
 * new operation) must get a chat, not `sessionExists` on every message.
 */
function refoundable(
  existing: AgentSessionRecord,
  request: AgentSessionAtRestCreateRequest
): boolean {
  return (
    !request.adoptedHandleLink &&
    existing.providerHandleChain.length === 0 &&
    agentSessionLeaseOwnerVerdict(existing.lease) === 'exited' &&
    sameIdentity(existing, request)
  )
}

/**
 * Founded again over the lease already there, so what that lease carries holds: its fence moves
 * on through the one mint (never back, never onto a floor a recovered copy set), and the chat keeps
 * what it already has, such as its name.
 */
function refounded(existing: AgentSessionRecord, founded: AgentSessionRecord): AgentSessionRecord {
  return {
    ...existing,
    ...founded,
    createdAt: existing.createdAt,
    lease: {
      ...existing.lease,
      ...founded.lease,
      runtimeFence: nextAgentSessionFence(existing.lease)
    }
  }
}

/**
 * Refuse an adoption whose conversation ANOTHER record already holds.
 *
 * It runs inside the store transaction because the pre-commit check in the RPC resolver cannot be
 * the guard: two concurrent adoptions of one conversation mint different session ids, so neither
 * sees the other's record and both would pass. Codex permits two app-servers on one thread
 * silently, so the cost of missing this is a corrupted conversation rather than an error.
 */
function assertAdoptedConversationUnowned(
  state: AgentSessionStoreState,
  request: Pick<AgentSessionAtRestCreateRequest, 'sessionId' | 'adoptedHandleLink'>
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
    const holdsSameConversation = record.providerHandleChain.some(
      (link) => agentSessionProviderHandleRoot(link.handle) === root
    )
    if (holdsSameConversation) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  }
}

/**
 * A tab id names one conversation, so a reserved id another session's tab holds is a conflict.
 * Checked, not claimed: the id is taken when the chat's tab is published, so a create that never
 * gets that far leaves nothing in the table to restore or release.
 */
function assertReservedTabUnheld(
  state: AgentSessionStoreState,
  request: Pick<AgentSessionAtRestCreateRequest, 'sessionId' | 'surfaceTabId'>
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
