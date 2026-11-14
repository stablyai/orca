import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { JournalSqlDatabase } from '../../../agent-session-journal/database/journal-sql-database'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { openStructuredAgentSessionConversationJournal } from '../structured-agent-session-conversation-open'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger.test-fixture'

/** Open through the production conversation path so hostless attach tests adopt the same journal. */
export function openTestAttachConversation(
  journalDatabase: JournalSqlDatabase
): (record: AgentSessionRecord) => Promise<AgentSessionJournal> {
  return async (record) =>
    (
      await openStructuredAgentSessionConversationJournal(
        { journalDatabase, logger: recordingStructuredAgentSessionLogger().logger },
        agentSessionConversationView(record),
        {
          acquisition: true
        }
      )
    ).session.journal
}
