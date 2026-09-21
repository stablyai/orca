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
