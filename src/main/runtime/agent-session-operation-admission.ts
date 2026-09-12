// Ledger admission for mutations that are not reservations — send, cancel, an
// approval answer. Split from the store so the store keeps only the transaction.

import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'

export type AgentSessionOperationAdmission = {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}

type OperationRows = Map<string, AgentSessionOperationRow>

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
