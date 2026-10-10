import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { commitAgentSessionFounding } from './agent-session-founding-admission'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { draftAgentSessionStoreState } from './agent-session-store-draft'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

/** Founding shares the store's admission and publishes only after the message transaction commits. */
export function createAgentSessionFoundingStore(
  transactions: AgentSessionStoreTransactions,
  firstRecordListeners: ReadonlySet<() => void>
) {
  return {
    prepare: (request: AgentSessionReserveRequest) =>
      commitAgentSessionFounding(draftAgentSessionStoreState(transactions.state), request),
    commit: async (request: AgentSessionReserveRequest) => {
      let heldBefore = true
      const result = await transactions.transact((draft) => {
        heldBefore = draft.records.size > 0 || draft.unreadableRecords.size > 0
        return commitAgentSessionFounding(draft, request)
      })
      if (!heldBefore) {
        firstRecordListeners.forEach((listener) => listener())
      }
      return result
    },
    receipt: (request: AgentSessionReserveRequest): JournalOperationReceipt => {
      let heldBefore = true
      const receipt = transactions.receipt((draft) => {
        heldBefore = draft.records.size > 0 || draft.unreadableRecords.size > 0
        const result = commitAgentSessionFounding(draft, request)
        if (result.disposition === 'replayed') {
          throw agentSessionRefusalError('agent_session_operation_unknown', {
            reason: 'outcomeUnknown'
          })
        }
      })
      return {
        write: receipt.write,
        committed: () => {
          receipt.committed()
          if (!heldBefore) {
            firstRecordListeners.forEach((listener) => listener())
          }
        }
      }
    }
  }
}
