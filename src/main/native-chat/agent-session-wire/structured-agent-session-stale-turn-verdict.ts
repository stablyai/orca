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
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'

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

function staleSessionLifecycleRevisions(
  items: readonly AgentJournalRenderItem[]
): JournalLifecycleMutationInput[] {
  const revisions: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      continue
    }
    const cancelled =
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
        ? cancelledJournalPromptBody(item.body)
        : null
    if (cancelled) {
      revisions.push({ kind: 'item', identity, body: cancelled })
    }
  }
  revisions.push(...runningTurnLifecycleRevisions(items, UNVERIFIABLE_TURN_VERDICT))
  return revisions
}

/** The verdict owns the turn's end and nothing else; every other field the row
 *  carries, including ones this build does not know, stays as it was. */
function settledLifecycle(
  lifecycle: AgentJournalTurnLifecycle,
  verdict: StructuredAgentSessionTurnVerdict
): AgentJournalTurnLifecycle {
  const {
    state: _state,
    outcome: _outcome,
    completedAt: _completedAt,
    durationMs: _durationMs,
    ...kept
  } = lifecycle
  return verdict.state === 'interrupted'
    ? { ...kept, state: verdict.state, completedAt: verdict.completedAt }
    : { ...kept, state: verdict.state }
}

/** A running row found when a NEW child is acquired belongs to a generation whose exit nobody
 *  observed. Must run before that child's buffered events land, or a live turn would be judged. */
export async function settleStaleSessionStateOnAcquire(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
}): Promise<number> {
  const { journal } = input
  const revisions = staleSessionLifecycleRevisions(journal.snapshot().items)
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  const settlementId = `stale-session:${input.sessionId}:${input.fence}:${generation}`
  for (const chunk of partitionJournalLifecycleMutations(settlementId, revisions)) {
    await journal.appendLifecycleBatch({
      settlementId: chunk.settlementId,
      fence: input.fence,
      recovered: true,
      mutations: chunk.mutations
    })
  }
  return revisions.length
}
