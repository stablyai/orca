import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

/** Open through the production conversation path so hostless attach tests adopt the same journal. */
export function openTestAttachConversation(
  journalDatabase: JournalHostDatabase
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
