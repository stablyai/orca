import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { AgentSessionJournal } from './journal-store'

export async function openAgentSessionJournal(
  options: AgentSessionJournalOptions
): Promise<AgentSessionJournal> {
  const journal = new AgentSessionJournal(options)
  await journal.open()
  return journal
}
