import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentType } from '../../../shared/agent-status-types'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

/** What a sender is now: its recorded name, never an agent-painted title, and its agent. */
export type SenderSnapshot = { name: string | null; agent: AgentType | null }

/** reportedDispatchId comes from worker_done. */
export type SenderSnapshotResolver = (
  party: AgentMessageSender['party'],
  reportedDispatchId?: string
) => SenderSnapshot

/** Snapshot the sender's name and agent before its party disappears. */
export function agentMessageSender(
  address: string,
  db: OrchestrationDb | null,
  senderSnapshot: SenderSnapshotResolver,
  reportedDispatchId?: string
): AgentMessageSender {
  const party = senderParty(address, db)
  const snapshot = snapshotSender(senderSnapshot, party, reportedDispatchId)
  return {
    party,
    name: agentMessageSenderName(snapshot.name),
    ...(snapshot.agent ? { agent: snapshot.agent } : {})
  }
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

function snapshotSender(
  senderSnapshot: SenderSnapshotResolver,
  party: AgentMessageSender['party'],
  reportedDispatchId: string | undefined
): SenderSnapshot {
  try {
    return senderSnapshot(party, reportedDispatchId)
  } catch {
    // Failure to resolve a label must not block delivery.
    return { name: null, agent: null }
  }
}
