import type { AgentJournalCursor } from '../../../shared/agent-session-journal-identity'
import type { AgentSessionJournalBatch } from '../../../shared/agent-session/agent-session-wire'

/** A batch that advances nothing: the carrier for fence, roster, and clock updates. */
export function emptyAgentSessionBatch(cursor: AgentJournalCursor): AgentSessionJournalBatch {
  return { cursor, items: [], removedItemIds: [], submissions: [] }
}
