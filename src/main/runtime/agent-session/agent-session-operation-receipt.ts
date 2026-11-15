import type { JournalOperationReceipt } from '../../native-chat/agent-session-journal/writing/journal-row-writer'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import type {
  settleAgentSessionOperationInto,
  AgentSessionOperationAcceptance
} from './ownership/agent-session-operation-admission'
import type { AgentSessionRecordAcceptance } from './records/agent-session-store-mutation'
import type { AgentSessionStoreTransactions } from './records/agent-session-store-transactions'

export type AgentSessionOperationReceiptInput = (
  | Parameters<typeof settleAgentSessionOperationInto>[1]
  | (AgentSessionOperationAcceptance & { outcome: AgentSessionOperationOutcome })
) & { record?: { sessionId: string; action: AgentSessionRecordAcceptance } }

export function agentSessionOperationOutcomeReceipt(
  transactions: AgentSessionStoreTransactions,
  args: AgentSessionOperationReceiptInput
): JournalOperationReceipt {
  const submissionSessionId =
    args.outcome.status === 'succeeded' ? args.outcome.sessionId : undefined
  const { record, ...operation } = args
  return transactions.mutationReceipt(
    {
      kind: 'operation',
      operation,
      ...(record ? { record } : {}),
      ...(submissionSessionId ? { wakeSessionId: submissionSessionId } : {})
    },
    submissionSessionId
  )
}
