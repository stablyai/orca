// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires proof that the child which wrote the turn is gone: death evidence naming
// that turn's owner by fence — a watched exit, or a local probe that found the recorded pid gone or
// reused. A release nothing proved — lost contact, an unverifiable identity, a stop that outlived the
// ladder — carries none, and neither does a later owner's death; the turn is then `unverifiable`
// with no end at all, until a proof naming its owner is written and revises it.

import {
  interruptedAgentJournalToolCall,
  isUnverifiedEndAgentJournalToolCall
} from '../../../shared/agent-journal-tool-call-lifecycle'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnVerdict =
  /** Whose end it was is the Stop event's to say, where the row is built (`turnEndAfterStop`). */
  { state: 'interrupted'; completedAt: number } | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  /** Fence of the owner that wrote the turn. */
  turnFence: number | undefined,
  /** When a Stop event found the turn running (`stopFoundTurnLiveAt`): a later proof of life. */
  liveAt?: number
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
  // counts the time Orca was down. Timeline rows don't: a send can land there after the death. A
  // Stop that found the turn running is a later renewal, so the end reads after that Stop.
  const lastAlive = Math.max(evidence.lastProvenAliveAt ?? evidence.observedAt, liveAt ?? 0)
  return { state: 'interrupted', completedAt: Math.min(lastAlive, evidence.observedAt) }
}

/** When the latest Stop event found `item`'s turn running: E1 writes one only for a live turn. */
export function stopFoundTurnLiveAt(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  item: AgentJournalRenderItem
): number | undefined {
  const stop = journal.stopMarks.latest()
  const turnId = readAgentJournalTurn(item.body)?.turnId
  return stop && turnId !== undefined && stop.event.turnId === turnId ? stop.event.at : undefined
}

/** Every turn this settle interrupts is a person's Stop's to end (`turnEndAfterStop`), so it reads
 *  as theirs, muted, with no row saying the provider stopped: as a live Stop writes none. */
export function endedByPersonsStop(
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  turnEnds: readonly JournalLifecycleMutationInput[]
): boolean {
  const interrupted = turnEnds.flatMap((mutation) => {
    const turn = mutation.kind === 'item' ? readAgentJournalTurn(mutation.body) : undefined
    return turn?.state === 'interrupted' ? [turn] : []
  })
  return (
    interrupted.length > 0 &&
    interrupted.every((turn) => journal.stopMarks.personStopDecides(turn.turnId, turn.completedAt))
  )
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
  journal: Pick<AgentSessionJournal, 'itemFence' | 'stopMarks'>
): JournalLifecycleMutationInput[] {
  const ownerFence = evidence?.ownerFence
  if (ownerFence === undefined) {
    return []
  }
  return items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.state === 'unverifiable' && journal.itemFence(item.itemId) === ownerFence
      ? turnLifecycleRevision(
          item,
          turn,
          turnVerdictFromDeathEvidence(evidence, ownerFence, stopFoundTurnLiveAt(journal, item))
        )
      : []
  })
}

/** An exit this host watched, of the child that holds `ownerFence`. */
export type StructuredAgentSessionWatchedExit = { ownerFence: number; observedAt: number }

/** What a watched exit revises of what its child left `unverifiable` (its stream closed before the
 *  exit was proven), calls and turns alike, as the record's death evidence later would. The exit's
 *  instant is the end, so no Stop mark is weighed. */
export function watchedExitRevisions(
  items: readonly AgentJournalRenderItem[],
  exit: StructuredAgentSessionWatchedExit | undefined,
  journal: Pick<AgentSessionJournal, 'itemFence'>
): JournalLifecycleMutationInput[] {
  if (!exit) {
    return []
  }
  const proof: AgentSessionDeathEvidence = { kind: 'exit-observed', detail: '', ...exit }
  return [
    ...provenUnverifiedToolCallRevisions(items, proof, journal),
    ...items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn?.state === 'unverifiable' && journal.itemFence(item.itemId) === exit.ownerFence
        ? turnLifecycleRevision(item, turn, { state: 'interrupted', completedAt: exit.observedAt })
        : []
    })
  ]
}

/** The calls those settles closed with no proof, revised by the same proof: each only when it names
 *  the owner that wrote the call, so a call that failed on its own stays failed. */
export function provenUnverifiedToolCallRevisions(
  items: readonly AgentJournalRenderItem[],
  evidence: AgentSessionDeathEvidence | null | undefined,
  journal: Pick<AgentSessionJournal, 'itemFence'>
): JournalLifecycleMutationInput[] {
  const ownerFence = evidence?.ownerFence
  if (ownerFence === undefined) {
    return []
  }
  return items.flatMap((item): JournalLifecycleMutationInput[] => {
    const identity = parseAgentJournalItemKey(item.itemId)
    return identity &&
      item.body.kind === 'tool-call' &&
      isUnverifiedEndAgentJournalToolCall(item.body) &&
      journal.itemFence(item.itemId) === ownerFence
      ? [
          {
            kind: 'item',
            identity,
            body: interruptedAgentJournalToolCall(item.body),
            turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
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
    ? [
        {
          kind: 'item',
          identity,
          body: agentJournalTurnBody(settledLifecycle(turn, verdict)),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
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
  return {
    ...kept,
    state: verdict.state,
    completedAt: Math.max(verdict.completedAt, began)
  }
}
