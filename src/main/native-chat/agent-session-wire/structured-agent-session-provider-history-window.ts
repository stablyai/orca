import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function readProviderHistoryBeforeAcquisition(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  accountHome: AgentSessionAccountHome
  ownerAlreadyAdmitted: boolean
}): Promise<ProviderHistoryWindow | null> {
  if (!input.adapter.providerHistoryWindow) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await input.adapter.providerHistoryWindow({
      identity: input.identity,
      accountHome: input.accountHome
    })
  } catch {
    return null
  }
  // An admitted lease can still belong to a child this process has not indexed.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
}
