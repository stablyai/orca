// What the provider recorded after the journal's last committed item, sampled before an attach
// acquires a new child: once one is running, an absent prompt no longer proves non-delivery.

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
  // A lease that was already live may belong to a provider child this process
  // has not indexed yet. Preserve the safe unknown outcome in that case.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
}
