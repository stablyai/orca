// Which Orca runtime held each chat's agent, and, when that agent is later proven dead, whether it
// died with that runtime and how the runtime ended. Applied to every store transaction, so a death
// any transition proves (a restart's adjudication, recovery's stop of a survivor) is told the same
// way. When anything is unknown (an owner an older build recorded, a terminal's claim, a runtime
// with no readable record) the death names no cause and the chat keeps its generic words.

import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

/** This Orca runtime: one per process, so a relaunch is a new one. */
let incarnation = randomUUID()

export function agentSessionRuntimeIncarnation(): string {
  return incarnation
}

/** For tests that relaunch Orca inside one process. */
export function beginAgentSessionRuntimeIncarnationForTest(): void {
  incarnation = randomUUID()
}

function attributed(
  before: AgentSessionRecord | undefined,
  after: AgentSessionRecord,
  runtimeEnds: AgentSessionStoreState['runtimeEnds']
): AgentSessionRecord {
  const { ownerProcess, deathEvidence } = after.lease
  // An owner this transaction recorded is this runtime's.
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
    // A terminal's agent, which an older build recorded: its transport was never Orca's.
    before?.lease.claimStatus === 'conflicted' ||
    !runtimeEnds
  ) {
    return after
  }
  // Unrecorded, pruned or unreadable: no cause. A crash is only a runtime that started and never ended.
  const runtimeEnd = runtimeEnds.get(heldBy)
  if (!runtimeEnd) {
    return after
  }
  return { ...after, lease: { ...after.lease, deathEvidence: { ...deathEvidence, runtimeEnd } } }
}

/** Stamps what this transaction learned about runtimes onto the records it changed. */
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
