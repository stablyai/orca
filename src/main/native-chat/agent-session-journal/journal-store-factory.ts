import type { AgentSessionJournalOptions } from './journal-store-contracts'
import { AgentSessionJournal } from './journal-store'

export function openAgentSessionJournal(
  options: AgentSessionJournalOptions
): Promise<AgentSessionJournal> {
  return AgentSessionJournal.open(options)
}
