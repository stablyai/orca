import {
  getAgentSessionConversation,
  selectWritableAgentSessionRecord,
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from '../../agent-session-store-state'
import type { AgentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import {
  agentSessionOperationKey,
  agentSessionOperationExpiry,
  claimAgentSessionOperation,
  evaluateAgentSessionOperation,
  findAgentSessionGlobalOperationRow,
  pruneAgentSessionOperationRows,
  settleAgentSessionOperation,
  pendingAgentSessionOperationRow,
  type AgentSessionOperationClaim,
  type AgentSessionOperationDecision,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionMutation,
  agentSessionLedgerRefusal,
  type AgentSessionMutationAdmission
} from '../../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session-wire'
import { AgentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

export type AgentSessionOperationAdmission = {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}

export type AgentSessionOperationAcceptance = AgentSessionOperationAdmission & {
  operationIdScope?: 'global'
}

// TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
export function insertAcceptedAgentSessionOperationInto(
  state: Pick<AgentSessionStoreState, 'operations'>,
  args: AgentSessionOperationAcceptance & { outcome: AgentSessionOperationOutcome }
): void {
  const candidates = args.operationIdScope
    ? state.operations.values()
    : [state.operations.get(agentSessionOperationKey(args.callerKey, args.operationId))]
  let exists = false
  for (const row of candidates) {
    if (!row || row.operationId !== args.operationId) {
      continue
    }
    if (row.fingerprint !== args.fingerprint) {
      throw new AgentSessionRefusalError(
        agentSessionLedgerRefusal(
          { clientOperationId: args.operationId },
          {
            decision: 'refused',
            code: 'agent_session_operation_conflict',
            details: { reason: 'operationIdReused' }
          }
        )
      )
    }
    exists = true
  }
  if (!exists) {
    state.operations.set(agentSessionOperationKey(args.callerKey, args.operationId), {
      ...pendingAgentSessionOperationRow(args),
      expiresAt: agentSessionOperationExpiry(args.now, args.now),
      outcome: args.outcome
    })
  }
}

type OperationRows = Map<string, AgentSessionOperationRow>

export type AgentSessionMutationOperationAdmission = {
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  hostFingerprint: string
  now: number
  operationIdScope?: 'global'
  conversationWrite?: true
}

export type AgentSessionMutationOperationDecision = {
  admission: AgentSessionMutationAdmission
  record: AgentSessionConversationView
} | null

type EvaluatedOperationRows = { rows: OperationRows; decision: AgentSessionOperationDecision }

export function evaluateAgentSessionOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): EvaluatedOperationRows {
  const pruned = pruneAgentSessionOperationRows(rows, args.now)
  return { rows: pruned, decision: evaluateAgentSessionOperation({ rows: pruned, ...args }) }
}

/** Send ids retain delivery identity across authenticated caller changes. */
export function evaluateAgentSessionGlobalOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): EvaluatedOperationRows {
  const existing = findAgentSessionGlobalOperationRow(rows, args.operationId, args.now)
  if (!existing) {
    return evaluateAgentSessionOperationRow(rows, args)
  }
  const syntheticRows = new Map([
    [agentSessionOperationKey(args.callerKey, args.operationId), existing]
  ])
  return {
    rows: pruneAgentSessionOperationRows(rows, args.now),
    decision: evaluateAgentSessionOperation({ rows: syntheticRows, ...args })
  }
}

/** Place admitted rows inside one transaction so concurrent copies cannot both win. */
function placeAdmittedAgentSessionOperationRow(
  evaluated: EvaluatedOperationRows,
  args: AgentSessionOperationAdmission
): EvaluatedOperationRows {
  if (evaluated.decision.decision === 'admit') {
    evaluated.rows.set(
      agentSessionOperationKey(args.callerKey, args.operationId),
      evaluated.decision.row
    )
  }
  return evaluated
}

export function admitAgentSessionOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): EvaluatedOperationRows {
  return placeAdmittedAgentSessionOperationRow(evaluateAgentSessionOperationRow(rows, args), args)
}

export function admitAgentSessionGlobalOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): EvaluatedOperationRows {
  return placeAdmittedAgentSessionOperationRow(
    evaluateAgentSessionGlobalOperationRow(rows, args),
    args
  )
}

/** Evaluate mutation replay before acquiring an owner; writes nothing, checks no lease, null means no record. */
export function evaluateAgentSessionMutationOperation(
  state: AgentSessionStoreState,
  args: AgentSessionMutationOperationAdmission
): { decision: AgentSessionOperationDecision; record: AgentSessionConversationView } | null {
  const record = getAgentSessionConversation(state, args.envelope.sessionId)
  if (!record) {
    return null
  }
  const operation = mutationOperation(args)
  const evaluated = args.operationIdScope
    ? evaluateAgentSessionGlobalOperationRow(state.operations, operation)
    : evaluateAgentSessionOperationRow(state.operations, operation)
  return { decision: evaluated.decision, record }
}

function mutationOperation(
  args: AgentSessionMutationOperationAdmission
): AgentSessionOperationAdmission {
  return {
    callerKey: args.callerKey,
    operationId: args.envelope.clientOperationId,
    fingerprint: args.hostFingerprint,
    now: args.now
  }
}

/** Admit the ledger row and its writer-lease precondition in one durable transaction. */
export function admitAgentSessionMutationOperation(
  state: AgentSessionStoreState,
  args: AgentSessionMutationOperationAdmission
): AgentSessionMutationOperationDecision {
  const record = getAgentSessionConversation(state, args.envelope.sessionId)
  if (!record) {
    if (selectWritableAgentSessionRecord(state, args.envelope.sessionId).kind === 'unreadable') {
      requireWritableAgentSessionRecord(state, args.envelope.sessionId)
    }
    return null
  }
  const operation = mutationOperation(args)
  const ledger = args.operationIdScope
    ? admitAgentSessionGlobalOperationRow(state.operations, operation)
    : admitAgentSessionOperationRow(state.operations, operation)
  const admission = admitAgentSessionMutation({
    envelope: args.envelope,
    hostFingerprint: args.hostFingerprint,
    ledger: ledger.decision,
    lease: () => requireWritableAgentSessionRecord(state, args.envelope.sessionId).lease,
    ...(args.conversationWrite ? { conversationWrite: true } : {})
  })
  if (ledger.decision.decision === 'admit' && admission.decision === 'refused') {
    ledger.rows.delete(agentSessionOperationKey(operation.callerKey, operation.operationId))
  }
  state.operations = ledger.rows
  return { admission, record }
}

/** Keep operation-map replacement in its owning module across admission and claim paths. */
export function admitAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: AgentSessionOperationAdmission
): AgentSessionOperationDecision {
  const admitted = admitAgentSessionOperationRow(state.operations, args)
  state.operations = admitted.rows
  return admitted.decision
}

export function admitAgentSessionGlobalOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: AgentSessionOperationAdmission
): AgentSessionOperationDecision {
  const admitted = admitAgentSessionGlobalOperationRow(state.operations, args)
  state.operations = admitted.rows
  return admitted.decision
}

export function claimAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: { callerKey: string; operationId: string }
): AgentSessionOperationClaim {
  const claimed = claimAgentSessionOperation(state.operations, args)
  state.operations = claimed.rows
  return claimed.claim
}

/** Whether an admission left the right to run open, so the same transaction should claim it. */
export type ClaimAfterAdmission = (decision: AgentSessionOperationDecision) => boolean

/** Combine admission and optional claim into one durable write before the effect. */
export function admitAndClaimAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: AgentSessionOperationAdmission,
  claimAfter: ClaimAfterAdmission
): { decision: AgentSessionOperationDecision; claim: AgentSessionOperationClaim | null } {
  const decision = admitAgentSessionOperationInto(state, args)
  return {
    decision,
    claim: claimAfter(decision) ? claimAgentSessionOperationInto(state, args) : null
  }
}

export function settleAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: { callerKey?: string; operationId: string; outcome: AgentSessionOperationOutcome }
): void {
  state.operations = settleAgentSessionOperation(state.operations, args)
}
