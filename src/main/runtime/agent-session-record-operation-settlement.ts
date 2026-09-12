import {
  agentSessionOperationKey,
  settleAgentSessionOperation,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'

type ConditionalOperationOutcomeArgs = {
  callerKey: string
  operationId: string
  outcome: AgentSessionOperationOutcome
  current: 'pending' | 'unsettled'
}

export function settleAgentSessionRecordOperationIfCurrent(
  operations: ReadonlyMap<string, AgentSessionOperationRow>,
  args: ConditionalOperationOutcomeArgs
): Map<string, AgentSessionOperationRow> | null {
  const key = agentSessionOperationKey(args.callerKey, args.operationId)
  const status = operations.get(key)?.outcome.status
  if (status !== 'pending' && (args.current !== 'unsettled' || status !== 'unknown')) {
    return null
  }
  return settleAgentSessionOperation(operations, args)
}
