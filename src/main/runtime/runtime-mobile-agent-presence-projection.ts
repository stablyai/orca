import {
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'

// Derived alongside the legacy projection; symbols cannot enter JSON or client publications.
export const HOST_AGENT_PRESENCE_STATUS = Symbol('host-agent-presence-status')

export function projectHostAgentPresenceStatus(
  rows: readonly AgentStatusIpcPayload[]
): AgentStatusEntry | undefined {
  const row = rows.reduce<AgentStatusIpcPayload | undefined>(
    (latest, candidate) =>
      !latest || candidate.receivedAt > latest.receivedAt ? candidate : latest,
    undefined
  )
  if (!row?.agentPresence?.process) {
    return undefined
  }
  const identity = {
    agentPresence: row.agentPresence,
    paneKey: row.paneKey,
    updatedAt: row.receivedAt,
    stateStartedAt: row.stateStartedAt ?? row.receivedAt,
    stateHistory: [],
    ...(row.evidenceObservedAt !== undefined ? { evidenceObservedAt: row.evidenceObservedAt } : {}),
    ...(row.terminalHandle ? { terminalHandle: row.terminalHandle } : {}),
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.tabId ? { tabId: row.tabId } : {})
  }
  // Why: an exited owner is identity history; its session, model and type must not reach a successor.
  if (row.agentPresence.ended) {
    return { ...identity, state: row.state, prompt: '' }
  }
  return {
    ...pickParsedAgentStatusPayload(row),
    ...identity,
    agentType: row.agentPresence.agent,
    ...(row.providerSession ? { providerSession: row.providerSession } : {})
  }
}
