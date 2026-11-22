import type { AgentJournalTurnOpenerRows } from '../../../shared/agent-session/journal/agent-session-journal-turn-opener'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentSessionJournalReads } from './journal-reads'

/** `items` with their turn rows' openers resolved through the journal's item aliases. */
export async function readJournalTurnOpenerRows(
  reads: Pick<AgentSessionJournalReads, 'canonicalItemIds'>,
  items: readonly AgentJournalRenderItem[]
): Promise<AgentJournalTurnOpenerRows> {
  const named = new Set<string>()
  for (const item of items) {
    const userItemId = readAgentJournalTurn(item.body)?.userItemId
    if (userItemId) {
      named.add(userItemId)
    }
  }
  const resolved = named.size > 0 ? await reads.canonicalItemIds([...named]) : []
  return {
    items,
    openerIds: new Map(
      resolved
        .filter(({ itemId, canonicalItemId }) => itemId !== canonicalItemId)
        .map(({ itemId, canonicalItemId }) => [itemId, canonicalItemId])
    )
  }
}
