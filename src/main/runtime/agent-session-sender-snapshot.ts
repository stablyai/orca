import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { AgentSessionStoreTransactions } from './agent-session/records/agent-session-store-transactions'
import {
  getAgentSessionConversation,
  hasAgentSessionConversation,
  listAgentSessionConversations
} from './agent-session/records/agent-session-store-state'
import { agentSessionVisibleTabIndex } from './agent-session/agent-session-tab-table'
import { agentSessionRecordPredecessorIds } from './agent-session-record-lineage'
import { clearSuccessor } from './agent-session-sender-identity-revision'
import type { AgentSessionRecordReader } from './orchestration/structured-session-lineage'

/** Native candidates and immutable canonical conversations share the same admitted commit boundary. */
export async function openAgentSessionSenderSnapshot(
  database: JournalHostDatabase,
  transactions: AgentSessionStoreTransactions
): Promise<{
  records: AgentSessionRecordReader
  revision: number
  close: () => Promise<void>
}> {
  const lease = await database.snapshot(() => ({
    state: transactions.state,
    revision: transactions.senderIdentityRevision
  }))
  const { state, revision } = lease.view
  const getRecord = (id: string) => getAgentSessionConversation(state, id)
  return {
    revision,
    close: lease.close,
    records: {
      getRecord,
      listRecords: () => listAgentSessionConversations(state),
      senderIdentityRevision: () => revision,
      getVisibleSessionTabIndex: () => agentSessionVisibleTabIndex(state),
      listVisibleSessionIds: function* () {
        for (const id of state.sessionTabs?.sessionIdsInOrder() ??
          transactions.legacySessionTabIds) {
          if (hasAgentSessionConversation(state, id)) {
            yield id
          }
        }
      },
      listClearedFrom: async (sessionId) => {
        const ids: string[] = []
        let visits = 0
        for await (const id of agentSessionRecordPredecessorIds(lease.read, sessionId)) {
          if (clearSuccessor(getRecord(id)) === sessionId) {
            ids.push(id)
          }
          if (++visits % 256 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
        return ids
      }
    }
  }
}
