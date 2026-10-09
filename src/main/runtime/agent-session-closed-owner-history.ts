import type {
  AgentSessionDeathEvidence,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { agentSessionClosedOwnerKey, closedAgentSessionOwner } from './agent-session-closed-owner'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { agentSessionRuntimeIncarnation } from './agent-session-runtime-attribution'
import {
  adjudicateAgentSessionRestart,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'

export function retainAgentSessionReservationClosure(
  state: AgentSessionStoreState,
  record: AgentSessionRecord,
  probe: AgentSessionOwnerProbe,
  observedAt: number
): void {
  const proof = adjudicateAgentSessionRestart({ lease: record.lease, probe, observedAt })
  if (proof.disposition === 'evicted' && proof.evidence) {
    retainAgentSessionClosedOwner(state, record, proof.evidence)
  }
}

export function retainAgentSessionClosedOwner(
  state: AgentSessionStoreState,
  record: AgentSessionRecord,
  evidence: AgentSessionDeathEvidence
): void {
  if (evidence.ownerFence !== record.lease.runtimeFence) {
    return
  }
  const fact = closedAgentSessionOwner(record, evidence)
  if (fact) {
    const key = agentSessionClosedOwnerKey(fact)
    if (!state.closedOwners.has(key)) {
      state.closedOwners.set(key, fact)
    }
  }
}

/** Captures every proof writer after runtime attribution, before the draft's rows are written. */
export function captureAgentSessionClosedOwners(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState
): void {
  for (const [sessionId, record] of draft.records) {
    const before = published.records.get(sessionId)
    const evidence = record.lease.deathEvidence
    if (before && evidence && evidence !== before.lease.deathEvidence) {
      retainAgentSessionClosedOwner(draft, before, evidence)
    }
  }
  for (const [key, fact] of draft.closedOwners) {
    if (!draft.records.has(fact.sessionId) && !draft.unreadableRecords.has(fact.sessionId)) {
      draft.closedOwners.delete(key)
      continue
    }
    if (published.closedOwners.has(key)) {
      continue
    }
    const before = published.records.get(fact.sessionId)
    const runtime = before?.lease.ownerProcess?.runtime
    const runtimeEnd =
      runtime && runtime !== agentSessionRuntimeIncarnation()
        ? draft.runtimeEnds?.get(runtime)
        : undefined
    if (
      fact.evidence.runtimeEnd === undefined &&
      runtimeEnd &&
      before?.lease.claimStatus !== 'conflicted'
    ) {
      draft.closedOwners.set(key, { ...fact, evidence: { ...fact.evidence, runtimeEnd } })
    }
  }
}
