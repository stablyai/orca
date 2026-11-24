import type { JournalHistoryReplacementGuard } from '../journal-writer-command'
import type { JournalDomainContextCommit } from '../journal-domain-context-command'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

export function droppedJournalHistoryReplacement(
  guard: JournalHistoryReplacementGuard | undefined,
  physicalCursor: AgentJournalCursor,
  publicCursor: () => AgentJournalCursor
): JournalDomainContextCommit | null {
  if (
    !guard ||
    (Atomics.load(guard.permit, 0) === 1 &&
      Date.now() < guard.deadline &&
      physicalCursor.epoch === guard.expectedCursor.epoch &&
      physicalCursor.sequence === guard.expectedCursor.sequence)
  ) {
    return null
  }
  return {
    dropped: true,
    cursor: publicCursor(),
    physicalCursor,
    contextBoundary: null,
    coordinates: [],
    items: [],
    removedItemIds: [],
    removedTurnIds: [],
    cards: [],
    clear: null,
    receipts: [],
    inputChanged: false
  }
}
