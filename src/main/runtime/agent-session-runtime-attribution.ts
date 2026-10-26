// Attribute proven owner deaths through every store transaction using recorded runtime endings.
// Unknown/older-build/terminal owners retain generic guidance instead of an invented cause.

import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

let incarnation = randomUUID()

export function agentSessionRuntimeIncarnation(): string {
  return incarnation
}

export function beginAgentSessionRuntimeIncarnationForTest(): void {
  incarnation = randomUUID()
}

function attributed(
  before: AgentSessionRecord | undefined,
  after: AgentSessionRecord,
  runtimeEnds: AgentSessionStoreState['runtimeEnds']
): AgentSessionRecord {
  const { ownerProcess, deathEvidence } = after.lease
  if (ownerProcess && !ownerProcess.runtime && ownerProcess !== before?.lease.ownerProcess) {
    return {
      ...after,
      lease: { ...after.lease, ownerProcess: { ...ownerProcess, runtime: incarnation } }
    }
  }
  const heldBy = before?.lease.ownerProcess?.runtime
  if (
    !deathEvidence ||
    deathEvidence === before?.lease.deathEvidence ||
    deathEvidence.runtimeEnd !== undefined ||
    !heldBy ||
    heldBy === incarnation ||
    // Terminal-owned agents never depended on Orca's pipes.
    before?.lease.claimStatus === 'conflicted' ||
    !runtimeEnds
  ) {
    return after
  }
  // Only a recorded start without an end proves a crash; missing/pruned/unreadable records remain unknown.
  const runtimeEnd = runtimeEnds.get(heldBy)
  if (!runtimeEnd) {
    return after
  }
  return { ...after, lease: { ...after.lease, deathEvidence: { ...deathEvidence, runtimeEnd } } }
}

export function attributeAgentSessionRuntime(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState
): void {
  for (const [sessionId, record] of draft.records) {
    const before = published.records.get(sessionId)
    if (record !== before) {
      const next = attributed(before, record, draft.runtimeEnds)
      if (next !== record) {
        draft.records.set(sessionId, next)
      }
    }
  }
}
