// Sample before acquiring a child; once running, absent prompts cannot prove non-delivery.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function readProviderHistoryWindow(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  accountHome: AgentSessionRecord['accountHome']
  ownerAlreadyAdmitted: boolean
}): Promise<ProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.accountHome })
  } catch {
    return null
  }
  // An already-live lease may belong to an unindexed child; retain uncertainty.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
}
