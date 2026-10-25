import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

/** Use recorded names, never agent-painted titles; reportedDispatchId comes from worker_done. */
export type SenderNameResolver = (
  party: AgentMessageSender['party'],
  reportedDispatchId?: string
) => string | null

/** Snapshot the sender name before its party disappears. */
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
    // If worker identity is lost, retain only what its address proves.
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
    // Failure to resolve a label must not block delivery.
    return null
  }
}
