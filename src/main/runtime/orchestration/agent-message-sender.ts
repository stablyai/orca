// The one way any Orca send that speaks for another agent records who it is from: the sender's
// party as orchestration resolves its address, and a bounded snapshot of its name.

import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSender
} from '../../../shared/agent-session-message-source'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

/** A name from Orca's records for a party (never an agent-painted title); null when it has none.
 *  `reportedDispatchId`: the dispatch the sender's own `worker_done` in the message names. */
export type SenderNameResolver = (
  party: AgentMessageSender['party'],
  reportedDispatchId?: string
) => string | null

/** A sender as a message records it, named now, for when it is gone. */
export function agentMessageSender(
  address: string,
  db: OrchestrationDb | null,
  senderName: SenderNameResolver,
  reportedDispatchId?: string
): AgentMessageSender {
  const party = senderParty(address, db)
  return { party, name: snapshotName(senderName, party, reportedDispatchId) }
}

function senderParty(address: string, db: OrchestrationDb | null): AgentMessageSender['party'] {
  try {
    const { paneKey: _credential, ...party } = resolveOrchestrationParty(address, db)
    return party
  } catch {
    // A worker this host lost the identity of: what the address itself says.
    return { address, terminalHandle: null, orcaSessionId: parseOrcaSessionAddress(address) }
  }
}

function snapshotName(
  senderName: SenderNameResolver,
  party: AgentMessageSender['party'],
  reportedDispatchId: string | undefined
): string | null {
  try {
    return agentMessageSenderName(senderName(party, reportedDispatchId))
  } catch {
    // A name is a label, never a reason the message is not delivered.
    return null
  }
}
