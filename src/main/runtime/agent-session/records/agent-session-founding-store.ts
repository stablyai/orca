import { onJournalReceiptCommitted } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import { commitAgentSessionFounding } from './agent-session-founding-admission'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import { copyAgentSessionStoreCache } from './agent-session-store-cache'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

/** Founding shares the store's admission and publishes only after the message transaction commits. */
export function createAgentSessionFoundingStore(
  transactions: AgentSessionStoreTransactions,
  firstRecordListeners: ReadonlySet<() => void>
) {
  return {
    prepare: (request: AgentSessionReserveRequest) =>
      commitAgentSessionFounding(
        copyAgentSessionStoreCache(transactions.state),
        request,
        transactions.legacySessionTabIds
      ),
    commit: async (request: AgentSessionReserveRequest) => {
      const heldBefore =
        transactions.state.records.size > 0 || transactions.state.unreadableRecords.size > 0
      const result = await transactions.command({
        kind: 'found',
        request: { ...request, spawnToken: '' },
        leaseTtlMs: 0,
        legacyTabIds: transactions.legacySessionTabIds
      })
      if (!heldBefore) {
        firstRecordListeners.forEach((listener) => listener())
      }
      return result
    },
    receipt: (request: AgentSessionReserveRequest): JournalOperationReceipt => {
      const heldBefore =
        transactions.state.records.size > 0 || transactions.state.unreadableRecords.size > 0
      const receipt = transactions.mutationReceipt({
        kind: 'command',
        command: {
          kind: 'found',
          request: { ...request, spawnToken: '' },
          leaseTtlMs: 0,
          legacyTabIds: transactions.legacySessionTabIds,
          refuseReplay: true
        }
      })
      return onJournalReceiptCommitted(receipt, () => {
        if (!heldBefore) {
          firstRecordListeners.forEach((listener) => listener())
        }
      })
    }
  }
}
