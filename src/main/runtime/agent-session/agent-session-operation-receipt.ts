import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { JournalOperationReceipt } from '../../native-chat/agent-session-journal/writing/journal-row-writer'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import {
  insertAcceptedAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionOperationAcceptance
} from './ownership/agent-session-operation-admission'
import type { AgentSessionStoreTransactions } from './records/agent-session-store-transactions'

export type AgentSessionOperationReceiptInput = (
  | Parameters<typeof settleAgentSessionOperationInto>[1]
  | (AgentSessionOperationAcceptance & { outcome: AgentSessionOperationOutcome })
) & { record?: { sessionId: string; update: (record: AgentSessionRecord) => AgentSessionRecord } }

export function agentSessionOperationOutcomeReceipt(
  transactions: AgentSessionStoreTransactions,
  args: AgentSessionOperationReceiptInput
): JournalOperationReceipt {
  const submissionSessionId =
    args.outcome.status === 'succeeded' ? args.outcome.sessionId : undefined
  return transactions.receipt(
    (draft) => {
      if ('fingerprint' in args) {
        insertAcceptedAgentSessionOperationInto(draft, args)
      } else {
        settleAgentSessionOperationInto(draft, args)
      }
      if (args.record) {
        const record = draft.records.get(args.record.sessionId)
        if (record) {
          draft.records.set(record.sessionId, args.record.update(record))
        }
      }
    },
    // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
    'fingerprint' in args
      ? { insertOperationsIfAbsent: true, submissionSessionId }
      : { submissionSessionId }
  )
}
