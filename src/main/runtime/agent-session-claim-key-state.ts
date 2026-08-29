import { classifyObservedAgentSessionSpawnToken } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

export function isVerifiable(
  state: AgentSessionStoreState,
  keyId: string,
  now: number,
  retentionMs: number
): boolean {
  const retired = state.retiredClaimKeys.find((entry) => entry.keyId === keyId)
  return !retired || now - retired.retiredAt <= retentionMs
}

export function markConflicted(record: AgentSessionRecord, now: number): AgentSessionRecord {
  return {
    ...record,
    updatedAt: now,
    // A conflicted key must remain conflicted after its observing process exits.
    lease: { ...record.lease, claimStatus: 'conflicted', handoffStage: 'manual-recovery' }
  }
}

export function retire(
  state: AgentSessionStoreState,
  keyId: string,
  now: number,
  retentionMs: number
): void {
  if (!state.retiredClaimKeys.some((entry) => entry.keyId === keyId)) {
    state.retiredClaimKeys.push({ keyId, retiredAt: now })
  }
  state.retiredClaimKeys = state.retiredClaimKeys.filter(
    (entry) => now - entry.retiredAt <= retentionMs
  )
}

export function listOrphanSpawnTokens(
  records: readonly AgentSessionRecord[],
  observedTokens: readonly string[]
): string[] {
  const leases = records.map((record) => record.lease)
  return observedTokens.filter(
    (spawnToken) => classifyObservedAgentSessionSpawnToken({ spawnToken, leases }) === 'orphan'
  )
}
