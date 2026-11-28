import type { AgentSessionRunPlacement } from '../../shared/agent-session/lifecycle/agent-session-run-placement'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { currentPlacement } from './provider-relay-run-liveness'

type Records = {
  get: (sessionId: string) => AgentSessionRecord | null
  list: () => readonly AgentSessionRecord[]
}

/** The session host's records, read by agents shared between chats (which chats a kept one serves). */
let records: Records | null = null

export function installProviderRelayRecords(installed: Records | null): void {
  records = installed
}

export type ProviderRelayPlacedRun = {
  record: AgentSessionRecord
  placement: Extract<AgentSessionRunPlacement, { kind: 'relayed' }>
}

/**
 * The chat's last run, when it ran under a daemon and its recorded owner is still that run's agent
 * (a build that records no placement may have started a later run).
 */
export function providerRelayPlacedRun(record: AgentSessionRecord): ProviderRelayPlacedRun | null {
  const placement = currentPlacement(record)
  return placement?.kind === 'relayed' ? { record, placement } : null
}

export function providerRelayPlacedRunOf(sessionId: string): ProviderRelayPlacedRun | null {
  const record = records?.get(sessionId) ?? null
  return record ? providerRelayPlacedRun(record) : null
}
