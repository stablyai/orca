import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import {
  assertAdoptedConversationUnowned,
  assertReservedTabUnheld,
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  validateAgentSessionReservationInput,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session-reservation-admission'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { setAgentSessionTabVisibility } from './agent-session-tab-table'

/** The same create admission as a reservation, with no obligation to acquire an owner. */
export function commitAgentSessionFounding(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): AgentSessionReserveResult {
  const decision = evaluateAgentSessionReserveOperation(state, request)
  if (decision.decision === 'refused') {
    throw agentSessionRefusalError(decision.code, decision.details)
  }
  if (decision.decision === 'replay') {
    return {
      record: requireAgentSessionRecordForReplay(state, decision.row, request.sessionId),
      disposition: 'replayed',
      operationRow: decision.row
    }
  }
  validateAgentSessionReservationInput(request)
  if (request.expectedFence !== null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  if (state.unreadableRecords.has(request.sessionId)) {
    throw agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
  }
  if (state.records.has(request.sessionId)) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  assertAdoptedConversationUnowned(state, request)
  assertReservedTabUnheld(state, request)
  const founded = foundAgentSessionRecord(request, request)
  const record = request.adoptedHandleLink
    ? { ...founded, providerHandleChain: [request.adoptedHandleLink] }
    : founded
  const operationRow = {
    ...decision.row,
    outcome: { status: 'succeeded' as const, sessionId: request.sessionId }
  }
  state.records.set(request.sessionId, record)
  state.operations.set(
    agentSessionOperationKey(operationRow.callerKey, operationRow.operationId),
    operationRow
  )
  setAgentSessionTabVisibility(state, request.sessionId, true, request.surfaceTabId)
  return { record, disposition: 'created', operationRow }
}
