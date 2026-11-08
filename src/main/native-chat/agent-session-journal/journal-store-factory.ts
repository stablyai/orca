import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { AgentSessionJournal } from './journal-store'
import { capturePRPendingActions } from '../../github/pr-watch/pr-pending-actions'

export async function openAgentSessionJournal(
  options: AgentSessionJournalOptions
): Promise<AgentSessionJournal> {
  // Every open, acquisition-only included: a finished PR call's obligations commit with its row.
  const journal = new AgentSessionJournal({
    captureCommittedRows: capturePRPendingActions,
    ...options
  })
  await journal.open()
  return journal
}
