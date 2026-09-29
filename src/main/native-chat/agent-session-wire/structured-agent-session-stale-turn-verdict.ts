// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires proof that the child which wrote the turn is gone: death evidence naming
// that turn's owner by fence — a watched exit, or a local probe that found the recorded pid gone or
// reused. A release nothing proved — lost contact, an unverifiable identity, a stop that outlived the
// ladder — carries none, and neither does a later owner's death; the turn is then `unverifiable`
// with no end at all, until a proof naming its owner is written and revises it.

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
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnVerdict =
  | { state: 'interrupted'; completedAt: number }
  | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  /** Fence of the owner that wrote the turn. */
  turnFence: number | undefined
): StructuredAgentSessionTurnVerdict {
  if (!evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence === undefined) {
    // Evidence an older build wrote names no owner; it keeps the rule that build applied.
    return evidence.kind === 'exit-observed'
      ? { state: 'interrupted', completedAt: evidence.observedAt }
      : UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence !== turnFence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.kind === 'exit-observed') {
    return { state: 'interrupted', completedAt: evidence.observedAt }
  }
  // A probe finds a dead child long after it died; its last renewal bounds the end, so the turn never
  // counts the time Orca was down. Timeline rows don't: a send can land there after the death.
  return {
    state: 'interrupted',
    completedAt: Math.min(evidence.lastProvenAliveAt ?? evidence.observedAt, evidence.observedAt)
  }
}

/** Revises every still-running lifecycle item in place, keeping its identity and start. */
export function runningTurnLifecycleRevisions(
  items: readonly AgentJournalRenderItem[],
  verdict: StructuredAgentSessionTurnVerdict
): JournalLifecycleMutationInput[] {
  return items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.state === 'running' ? turnLifecycleRevision(item, turn, verdict) : []
  })
}

/**
 * A turn an earlier settle could only call `unverifiable`, because the proof had not been written
 * yet, revised once a proof names the owner that wrote it. Only ever upward, and never from an
 * older build's proof, which names no owner.
 */
export function provenUnverifiableTurnRevisions(
  items: readonly AgentJournalRenderItem[],
  evidence: AgentSessionDeathEvidence | null | undefined,
  journal: Pick<AgentSessionJournal, 'itemFence'>
): JournalLifecycleMutationInput[] {
  const ownerFence = evidence?.ownerFence
  if (ownerFence === undefined) {
    return []
  }
  return items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.state === 'unverifiable' && journal.itemFence(item.itemId) === ownerFence
      ? turnLifecycleRevision(item, turn, turnVerdictFromDeathEvidence(evidence, ownerFence))
      : []
  })
}

function turnLifecycleRevision(
  item: AgentJournalRenderItem,
  turn: AgentJournalTurnLifecycle,
  verdict: StructuredAgentSessionTurnVerdict
): JournalLifecycleMutationInput[] {
  const identity = parseAgentJournalItemKey(item.itemId)
  return identity
    ? [{ kind: 'item', identity, body: agentJournalTurnBody(settledLifecycle(turn, verdict)) }]
    : []
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
  if (verdict.state !== 'interrupted') {
    return { ...kept, state: verdict.state }
  }
  // A renewal can predate the turn, which started with its owner alive; it never ends before that.
  const began = Math.max(lifecycle.requestedAt ?? 0, lifecycle.startedAt ?? 0)
  return { ...kept, state: verdict.state, completedAt: Math.max(verdict.completedAt, began) }
}
