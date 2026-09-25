import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'

/** For a test that attaches without a host: the conversation's journal, through the one open a
 *  host would take, so the attach under test adopts it the way it adopts the host's. */
export function openTestAttachConversation(
  journalRoot: string,
  adapter: Pick<StructuredAgentSessionAdapter, 'historyFilePath'> = {}
): (record: AgentSessionRecord) => Promise<AgentSessionJournal> {
  return async (record) =>
    (await openStructuredAgentSessionConversationJournal({ journalRoot, adapter }, record)).session
      .journal
}
