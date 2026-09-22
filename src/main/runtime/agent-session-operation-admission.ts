// Ledger admission for mutations that are not reservations — send, cancel, an
// approval answer. Split from the store so the store keeps only the transaction.

import {
  agentSessionOperationKey,
  claimAgentSessionOperation,
  evaluateAgentSessionOperation,
  pruneAgentSessionOperationRows,
  settleAgentSessionOperation,
  type AgentSessionOperationClaim,
  type AgentSessionOperationDecision,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionMutation,
  type AgentSessionMutationAdmission
} from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

export type AgentSessionOperationAdmission = {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}

type OperationRows = Map<string, AgentSessionOperationRow>

export type AgentSessionMutationOperationAdmission = {
  callerKey: string
  envelope: AgentSessionMutationEnvelope
  hostFingerprint: string
  now: number
  operationIdScope?: 'global'
}

export type AgentSessionMutationOperationDecision = {
  admission: AgentSessionMutationAdmission
  record: AgentSessionRecord
} | null

/** Prune, evaluate, and (on admit) place the row. The caller runs this inside one
 *  transaction, so two concurrent copies of an operation id cannot both admit. */
export function admitAgentSessionOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): { rows: OperationRows; decision: AgentSessionOperationDecision } {
  const pruned = pruneAgentSessionOperationRows(rows, args.now)
  const decision = evaluateAgentSessionOperation({ rows: pruned, ...args })
  if (decision.decision === 'admit') {
    pruned.set(agentSessionOperationKey(args.callerKey, args.operationId), decision.row)
  }
  return { rows: pruned, decision }
}

/** Send ids name one provider delivery even when the authenticated caller changes. */
export function admitAgentSessionGlobalOperationRow(
  rows: OperationRows,
  args: AgentSessionOperationAdmission
): { rows: OperationRows; decision: AgentSessionOperationDecision } {
  let existing: AgentSessionOperationRow | undefined
  for (const row of rows.values()) {
    if (row.expiresAt > args.now && row.operationId === args.operationId) {
      existing = row
      break
    }
  }
  if (!existing) {
    return admitAgentSessionOperationRow(rows, args)
  }
  const pruned = pruneAgentSessionOperationRows(rows, args.now)
  const syntheticRows = new Map([
    [agentSessionOperationKey(args.callerKey, args.operationId), existing]
  ])
  return {
    rows: pruned,
    decision: evaluateAgentSessionOperation({ rows: syntheticRows, ...args })
  }
}

/** Admit the ledger row and its lease/fence preconditions in one durable transaction. */
export function admitAgentSessionMutationOperation(
  state: AgentSessionStoreState,
  args: AgentSessionMutationOperationAdmission
): AgentSessionMutationOperationDecision {
  const record = state.records.get(args.envelope.sessionId)
  if (!record) {
    return null
  }
  const operation = {
    callerKey: args.callerKey,
    operationId: args.envelope.clientOperationId,
    fingerprint: args.hostFingerprint,
    now: args.now
  }
  const ledger = args.operationIdScope
    ? admitAgentSessionGlobalOperationRow(state.operations, operation)
    : admitAgentSessionOperationRow(state.operations, operation)
  const admission = admitAgentSessionMutation({
    envelope: args.envelope,
    hostFingerprint: args.hostFingerprint,
    ledger: ledger.decision,
    lease: record.lease
  })
  if (ledger.decision.decision === 'admit' && admission.decision === 'refused') {
    ledger.rows.delete(agentSessionOperationKey(operation.callerKey, operation.operationId))
  }
  state.operations = ledger.rows
  return { admission, record }
}

/**
 * Admit into the store's own rows, replacing them in place.
 *
 * The three admit paths and the claim path all did the same read-modify-return dance at the call
 * site; keeping it here means the rows map is only ever swapped by the module that owns its shape.
 */
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

export function settleAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: { callerKey?: string; operationId: string; outcome: AgentSessionOperationOutcome }
): void {
  state.operations = settleAgentSessionOperation(state.operations, args)
}
