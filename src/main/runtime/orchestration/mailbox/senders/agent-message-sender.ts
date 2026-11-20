import {
  liveSenderAgent,
  liveSenderName,
  observeOrchestrationSender,
  orchestrationSenderName,
  orchestrationSenderAgent,
  type SenderNamingSources,
  type SenderObservation
} from './orchestration-sender-name'
import {
  workerIdentity,
  workerIdentityName,
  type WorkerIdentity
} from '../../workers/identity/worker-identity'
import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSender
} from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { resolveOrchestrationParty } from '../../addressing/orchestration-party'
import { runCoordinatorKey } from '../../addressing/orchestration-caller-identity'
import { exposeUtcTimestamp } from '../../db/utc-timestamp'

/** What a sender is now: its recorded name, never an agent-painted title, its agent, and the paired
 *  server a worker there runs on. */
export type SenderSnapshot = {
  name: string | null
  agent: AgentType | null
  bot?: boolean
  host?: string
}

/** `recorded`: the worker the message was written from. A live chat or terminal name wins; once
 *  neither names the sender, its worker does, else the sender's own lookup. */
export function observeSenderSnapshot(
  party: AgentMessageSender['party'],
  sources: SenderNamingSources,
  reportedDispatchId?: string,
  recorded?: WorkerIdentity | null
): SenderSnapshot {
  const observation = observeOrchestrationSender(party, sources, reportedDispatchId)
  const liveName = liveSenderName(observation, sources)
  const worker = liveName ? null : (recorded ?? observedWorker(observation, sources.db))
  return {
    name:
      liveName ||
      (worker && workerIdentityName(worker)) ||
      orchestrationSenderName(party, sources, reportedDispatchId, observation),
    agent:
      liveSenderAgent(observation) ??
      worker?.agent ??
      orchestrationSenderAgent(sources, observation),
    ...(observation.chat?.bot ? { bot: true } : {}),
    ...(worker?.hostLabel ? { host: worker.hostLabel } : {})
  }
}

function observedWorker(
  observation: SenderObservation,
  db: OrchestrationDb | null
): WorkerIdentity | null {
  const dispatchId = observation.dispatch?.id ?? observation.remoteDispatch?.dispatch_id
  return db && dispatchId ? workerIdentity(db, dispatchId) : null
}

/** reportedDispatchId comes from worker_done; recorded is the worker the message was written from. */
export type SenderSnapshotResolver = (
  party: AgentMessageSender['party'],
  reportedDispatchId?: string,
  recorded?: WorkerIdentity | null
) => SenderSnapshot

/** Snapshot the sender's name and agent before its party disappears. `sentAt`: the message's
 *  `created_at`; omitted when it is being sent now. */
export function agentMessageSender(
  address: string,
  db: OrchestrationDb | null,
  senderSnapshot: SenderSnapshotResolver,
  reportedDispatchId?: string,
  sentAt?: string,
  recorded?: WorkerIdentity | null
): AgentMessageSender {
  const party = senderParty(address, db, sentAt)
  const snapshot = snapshotSender(senderSnapshot, party, reportedDispatchId, recorded)
  // Mail from another server is named by its label: "term_9f3c on Jinwoo's Mac".
  const peerLabel = !snapshot.name && db?.isPeerMailSenderLabel(address) ? address : null
  return {
    // A coordinator's terminal can later host another agent; only its session identifies it.
    party: address.startsWith('run:') ? { ...party, terminalHandle: null } : party,
    name: agentMessageSenderName(snapshot.name ?? peerLabel),
    ...(snapshot.agent ? { agent: snapshot.agent } : {}),
    ...(snapshot.bot ? { bot: true } : {}),
    ...(snapshot.host ? { host: snapshot.host } : {})
  }
}

function senderParty(
  address: string,
  db: OrchestrationDb | null,
  sentAt: string | undefined
): AgentMessageSender['party'] {
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
    // A run speaks as its coordinator, but only under the binding it was sent from.
    const run = db?.getRun(address.slice(4))
    const sent = sentAt ? exposeUtcTimestamp(sentAt) : null
    const coordinator = run && (!sent || sent >= run.updated_at) ? runCoordinatorKey(run) : null
    return {
      address,
      terminalHandle: coordinator?.terminalHandle ?? null,
      orcaSessionId: coordinator?.orcaSessionId ?? null
    }
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
  reportedDispatchId: string | undefined,
  recorded: WorkerIdentity | null | undefined
): SenderSnapshot {
  try {
    return senderSnapshot(party, reportedDispatchId, recorded)
  } catch {
    // Failure to resolve a label must not block delivery.
    return { name: null, agent: null }
  }
}
