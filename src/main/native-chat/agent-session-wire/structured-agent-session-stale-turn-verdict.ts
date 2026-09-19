// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires the host to have seen the child exit; that receipt is the only end time it
// is allowed to record. Everything weaker — a pid probe, an identity mismatch, a journal found
// running on a cold acquire — is `unverifiable` and carries no end at all.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'

export type StructuredAgentSessionTurnVerdict =
  | { state: 'interrupted'; completedAt: number }
  | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined
): StructuredAgentSessionTurnVerdict {
  return evidence?.kind === 'exit-observed'
    ? { state: 'interrupted', completedAt: evidence.observedAt }
    : UNVERIFIABLE_TURN_VERDICT
}

/** Revises every still-running lifecycle item in place, keeping its identity and start. */
export function runningTurnLifecycleRevisions(
  items: readonly AgentJournalRenderItem[],
  verdict: StructuredAgentSessionTurnVerdict
): JournalLifecycleMutationInput[] {
  const revisions: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    const turn = readAgentJournalTurn(item.body)
    if (turn?.state !== 'running') {
      continue
    }
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      continue
    }
    revisions.push({
      kind: 'item',
      identity,
      body: agentJournalTurnBody(settledLifecycle(turn, verdict))
    })
  }
  return revisions
}

function settledLifecycle(
  lifecycle: AgentJournalTurnLifecycle,
  verdict: StructuredAgentSessionTurnVerdict
): AgentJournalTurnLifecycle {
  const settled: AgentJournalTurnLifecycle = { turnId: lifecycle.turnId, state: verdict.state }
  if (lifecycle.userItemId !== undefined) {
    settled.userItemId = lifecycle.userItemId
  }
  if (lifecycle.startedAt !== undefined) {
    settled.startedAt = lifecycle.startedAt
  }
  if (lifecycle.requestedAt !== undefined) {
    settled.requestedAt = lifecycle.requestedAt
  }
  if (verdict.state === 'interrupted') {
    settled.completedAt = verdict.completedAt
  }
  return settled
}
