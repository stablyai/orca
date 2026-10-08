// Provider history for an attach's restart reconciliation, placed at the resume point it was read
// from. Reading is best effort: no reader, a failed read, or no history leaves every send exactly
// as the crash boundary wrote it.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandlesEqual,
  type AgentSessionProviderHandleChain
} from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  PlacedProviderHistoryWindow,
  ProviderHistoryWindow,
  ProviderHistoryWindowStart
} from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function sampleProviderHistoryWindow(input: {
  adapter: Pick<StructuredAgentSessionAdapter, 'providerHistoryWindow'>
  identity: AgentSessionJournalIdentity
  /** The record `identity` came from, read before this attach acquires a child. */
  record: AgentSessionRecord
  ownerAlreadyAdmitted: boolean
}): Promise<PlacedProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.record.accountHome })
  } catch {
    return null
  }
  if (!history) {
    return null
  }
  return {
    ...history,
    // A lease that was already live may belong to a provider child this process
    // has not indexed yet. Preserve the safe unknown outcome in that case.
    turnInFlight: history.turnInFlight || input.ownerAlreadyAdmitted,
    start: resumePointStart(input.record.providerHandleChain)
  }
}

/** Where the head's resume point was set: each acquisition re-proves an unmoved point as a new link,
 *  so it is the first of the trailing links that carry the head's handle, leaf included. */
export function resumePointStart(
  chain: AgentSessionProviderHandleChain
): ProviderHistoryWindowStart | null {
  let start = chain.at(-1)
  for (let index = chain.length - 2; start && index >= 0; index -= 1) {
    const link = chain[index]!
    if (!agentSessionProviderHandlesEqual(link.handle, start.handle)) {
      break
    }
    start = link
  }
  return start ? { fence: start.mintedAtFence, movedAt: start.observedAt } : null
}
