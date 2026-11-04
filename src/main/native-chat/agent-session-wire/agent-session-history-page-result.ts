import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { snapshotLatestTurn } from './agent-session-history-latest-turn'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHistoryDirection,
  AgentSessionSubagentRosterEntry,
  AgentSessionHistoryPage
} from '../../../shared/agent-session/agent-session-wire'

export function buildPage(input: {
  snapshot: AgentJournalSnapshot
  submissions?: AgentJournalSnapshot['submissions']
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  removedItemIds?: string[]
  hasOlder: boolean
  hasNewer: boolean
  fallbackCursor: AgentJournalCursor
  nextCursor: AgentJournalCursor | undefined
  fence?: number
  subagentRoster?: AgentSessionSubagentRosterEntry[]
}): AgentSessionHistoryPage {
  const epoch = input.snapshot.cursor.epoch
  const pageItemIds = new Set(input.items.map((item) => item.itemId))
  const oldest = input.items[0]
  const newest = input.items.at(-1)
  return {
    sessionId: input.snapshot.sessionId,
    epoch,
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
    direction: input.direction,
    items: input.items,
    removedItemIds: input.removedItemIds ?? [],
    submissions: (input.submissions ?? input.snapshot.submissions).filter((submission) =>
      pageItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
    ),
    window: {
      oldest: oldest ? { epoch, sequence: oldest.sequence } : null,
      newest: newest ? { epoch, sequence: newest.sequence } : null,
      nextCursor: input.nextCursor ?? input.fallbackCursor
    },
    liveCursor: input.snapshot.cursor,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
    ...(input.subagentRoster === undefined ? {} : { subagentRoster: input.subagentRoster }),
    // Read the whole timeline: long turns can begin below this page.
    latestTurn: snapshotLatestTurn(input.snapshot)
  }
}
