import {
  observeOrchestrationSender,
  orchestrationSenderName,
  orchestrationSenderAgent,
  type SenderNamingSources
} from './orchestration-sender-name'
import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSender
} from '../../../../../shared/agent-session/agent-session-message-source'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { resolveOrchestrationParty } from '../../addressing/orchestration-party'

/** What a sender is now: its recorded name, never an agent-painted title, and its agent. */
export type SenderSnapshot = { name: string | null; agent: AgentType | null }

export function observeSenderSnapshot(
  party: AgentMessageSender['party'],
  sources: SenderNamingSources,
  reportedDispatchId?: string
): SenderSnapshot {
  const observation = observeOrchestrationSender(party, sources, reportedDispatchId)
  return {
    name: orchestrationSenderName(party, sources, reportedDispatchId, observation),
    agent: orchestrationSenderAgent(sources, observation)
  }
}

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
  // Mail from another server is named by its label: "term_9f3c on Jinwoo's Mac".
  const peerLabel = !snapshot.name && db?.isPeerMailSenderLabel(address) ? address : null
  return {
    party,
    name: agentMessageSenderName(snapshot.name ?? peerLabel),
    ...(snapshot.agent ? { agent: snapshot.agent } : {})
  }
}

function senderParty(address: string, db: OrchestrationDb | null): AgentMessageSender['party'] {
  if (address.startsWith('dispatch:')) {
    const id = address.slice(9)
    return {
      address,
      terminalHandle: null,
      orcaSessionId: db?.getFederatedDispatch(id)
        ? null
        : (db?.getDispatchContextById(id)?.assignee_orca_session_id ?? null)
    }
  }
  if (address.startsWith('run:')) {
    return { address, terminalHandle: null, orcaSessionId: null }
  }
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
