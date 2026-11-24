// The person-side messages each of a chat's turns took, from Orca's own journal: the one that opened
// it and those steered into it. Who a turn acts for and whether it may leave its thread both read this.
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../shared/agent-session/requests/structured-agent-session-command-entry'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentTurnAnchors } from '../../shared/native-chat/transcript/turns/native-chat-turn-membership'

export function isRootUserMessage(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'user' &&
    isRootAgentJournalItem(item) &&
    !isStructuredAgentSessionCommandEntry(item.body)
  )
}

export function isRootTurnRecord(item: AgentJournalRenderItem): boolean {
  return isRootAgentJournalItem(item) && readAgentJournalTurn(item.body) !== null
}

/** Each of `turns` (root turn records in `items`)' messages, in the order given. A message still
 *  queued belongs to no turn yet. An opener found by journal order is never a message from before
 *  the turn record ahead of it, so a turn no message opened takes none. */
export function turnMessages(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  turns: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[][] {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const messages: { item: AgentJournalRenderItem; index: number }[] = []
  // The index of the turn record before each turn record.
  const previousRecord = new Map<string, number>()
  let lastRecord = -1
  items.forEach((item, index) => {
    if (isRootUserMessage(item)) {
      messages.push({ item, index })
    } else if (isRootTurnRecord(item)) {
      previousRecord.set(item.itemId, lastRecord)
      lastRecord = index
    }
  })
  return turns.map((turn) => {
    const opener = anchors.get(turn.itemId)
    const after = previousRecord.get(turn.itemId) ?? -1
    return messages.flatMap(({ item, index }) =>
      (item.itemId === opener && index > after) ||
      (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turn.itemId)
        ? [item]
        : []
    )
  })
}
