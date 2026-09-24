import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalBatch } from '../../../shared/agent-session-wire'

/** A batch that advances nothing: the carrier for fence, handoff, roster, and clock updates. */
export function emptyAgentSessionBatch(cursor: AgentJournalCursor): AgentSessionJournalBatch {
  return { cursor, items: [], removedItemIds: [], submissions: [] }
}
