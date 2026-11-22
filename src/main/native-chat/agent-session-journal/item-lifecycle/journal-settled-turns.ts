import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalRow } from '../durable-rows/journal-row-schema'

/** Turn rows a commit left terminal, in write order; another writer's Stop reaches producers this way. */
export function journalSettledTurnItemIds(rows: readonly JournalRow[]): string[] {
  const settled = new Map<string, boolean>()
  const visit = (itemId: string, body: Parameters<typeof readAgentJournalTurn>[0]) => {
    const turn = readAgentJournalTurn(body)
    if (turn) {
      settled.delete(itemId)
      settled.set(itemId, turn.state !== 'running')
    }
  }
  for (const row of rows) {
    if (row.kind === 'item') {
      visit(row.itemId, row.body)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        if (mutation.kind === 'item') {
          visit(mutation.itemId, mutation.body)
        }
      }
    }
  }
  return [...settled].flatMap(([itemId, terminal]) => (terminal ? [itemId] : []))
}
