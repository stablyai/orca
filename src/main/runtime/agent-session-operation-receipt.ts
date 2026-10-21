import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import type { AgentSessionOperationOutcome } from '../../shared/agent-session-operation-ledger'
import {
  insertAcceptedAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionOperationAcceptance
} from './agent-session-operation-admission'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

export type AgentSessionOperationReceiptInput =
  | Parameters<typeof settleAgentSessionOperationInto>[1]
  | (AgentSessionOperationAcceptance & { outcome: AgentSessionOperationOutcome })

export function agentSessionOperationOutcomeReceipt(
  transactions: AgentSessionStoreTransactions,
  args: AgentSessionOperationReceiptInput
): JournalOperationReceipt {
  if ('fingerprint' in args) {
    // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
    return transactions.receipt((draft) => insertAcceptedAgentSessionOperationInto(draft, args), {
      insertOperationsIfAbsent: true
    })
  }
  return transactions.receipt((draft) => settleAgentSessionOperationInto(draft, args))
}
