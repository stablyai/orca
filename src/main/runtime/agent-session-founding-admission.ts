import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../shared/agent-session-wire-refusals'
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
} from './agent-session/ownership/agent-session-reservation-admission'
import {
  selectWritableAgentSessionRecord,
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import { setAgentSessionTabVisibility } from './agent-session/agent-session-tab-table'

/** Use create admission without requiring owner acquisition. */
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
  const selected = selectWritableAgentSessionRecord(state, request.sessionId)
  if (selected.kind === 'unreadable') {
    requireWritableAgentSessionRecord(state, request.sessionId)
  }
  if (selected.kind === 'writable') {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  try {
    assertAdoptedConversationUnowned(state, request)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      throw new AgentSessionRefusalError({
        ...error.refusal,
        createAttemptRefusedBeforeCommit: true
      })
    }
    throw error
  }
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
