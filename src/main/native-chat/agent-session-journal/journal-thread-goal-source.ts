import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../shared/agent-session-thread-goal'

export type JournalThreadGoalSource = {
  goal: AgentJournalThreadGoal | null
  row: { identity: AgentJournalItemIdentity; text: string } | null
}

export function journalThreadGoalSource(
  items: Iterable<AgentJournalRenderItem>
): JournalThreadGoalSource {
  const source = currentAgentSessionThreadGoalSourceBySequence(items)
  const item = source?.item
  const identity = item ? parseAgentJournalItemKey(item.itemId) : null
  return {
    goal: source?.goal ?? null,
    row:
      source?.goal && item?.body.kind === 'status' && identity
        ? { identity, text: item.body.text }
        : null
  }
}
