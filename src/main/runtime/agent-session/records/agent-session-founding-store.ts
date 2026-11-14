import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import { commitAgentSessionFounding } from './agent-session-founding-admission'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import { copyAgentSessionStoreCache } from './agent-session-store-cache'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

/** Founding shares the store's admission and publishes only after the message transaction commits. */
export function createAgentSessionFoundingStore(transactions: AgentSessionStoreTransactions) {
  return {
    prepare: (request: AgentSessionReserveRequest) =>
      commitAgentSessionFounding(
        copyAgentSessionStoreCache(transactions.state),
        request,
        transactions.legacySessionTabIds
      ),
    commit: (request: AgentSessionReserveRequest) =>
      transactions.command({
        kind: 'found',
        request: { ...request, spawnToken: '' },
        leaseTtlMs: 0,
        legacyTabIds: transactions.legacySessionTabIds
      }),
    receipt: (request: AgentSessionReserveRequest): JournalOperationReceipt => {
      return transactions.mutationReceipt({
        kind: 'command',
        command: {
          kind: 'found',
          request: { ...request, spawnToken: '' },
          leaseTtlMs: 0,
          legacyTabIds: transactions.legacySessionTabIds,
          refuseReplay: true
        }
      })
    }
  }
}
