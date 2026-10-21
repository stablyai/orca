// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires proof that the turn is over: death evidence naming that turn's owner by
// fence (a watched exit, or a local probe that found the recorded pid gone or reused), or the
// replacement of the Orca runtime that held the owner's pipes, which this host proves by holding its
// lock. A release nothing proved within one runtime (an unverifiable identity, a stop that outlived
// the ladder) carries none, and neither does a later owner's death; the turn is then `unverifiable`
// with no end at all, until a proof naming its owner is written and revises it.

import {
  interruptedAgentJournalToolCall,
  isUnverifiedEndAgentJournalToolCall
} from '../../../shared/agent-journal-tool-call-lifecycle'
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
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session-replaced-runtime'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnVerdict =
  /** Whose end it was is the Stop event's to say, where the row is built (`turnEndAfterStop`). */
  { state: 'interrupted'; completedAt?: number } | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  /** Fence of the owner that wrote the turn. */
  turnFence: number | undefined,
  /** Saved provider output or a Stop that found the turn running: a later proof of life. */
  liveAt?: number
): StructuredAgentSessionTurnVerdict {
  if (!evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence === undefined) {
    // Evidence an older build wrote names no owner; it keeps the rule that build applied.
    return evidence.kind === 'exit-observed'
      ? interruptedTurnVerdict(evidence.observedAt)
      : UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence !== turnFence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.kind === 'exit-observed') {
    return interruptedTurnVerdict(evidence.observedAt)
  }
  // A probe finds a dead child long after it died; its last renewal bounds the end, so the turn never
  // counts the time Orca was down. Saved provider output and a Stop that found the turn running can
  // prove life after that renewal; a client's later send or a recovery write cannot.
  const lastAlive = Math.max(evidence.lastProvenAliveAt ?? evidence.observedAt, liveAt ?? 0)
  return interruptedTurnVerdict(Math.min(lastAlive, evidence.observedAt))
}

function interruptedTurnVerdict(completedAt: number): StructuredAgentSessionTurnVerdict {
  return Number.isFinite(completedAt) && completedAt > 0
    ? { state: 'interrupted', completedAt }
    : { state: 'interrupted' }
}

/** A turn whose owner a replaced runtime held is over: nothing it did after reaches the chat. It
 *  ends at the owner's last proof of life, which that runtime wrote before this one took over. */
export function turnVerdictFromReplacedRuntime(
  replaced: AgentSessionReplacedRuntime | undefined,
  turnFence: number | undefined,
  liveAt?: number
): StructuredAgentSessionTurnVerdict {
  if (!replaced || turnFence === undefined || turnFence > replaced.fence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  const renewedAt = turnFence === replaced.fence ? (replaced.lastProvenAliveAt ?? 0) : 0
  return interruptedTurnVerdict(Math.max(renewedAt, liveAt ?? 0))
}

/** The latest saved output from this turn's owner, including a Stop that found it running. */
export function lastProvenTurnLiveAt(
  journal: Pick<AgentSessionJournal, 'stopMarks' | 'itemFence' | 'lastProviderActivityAt'>,
  item: AgentJournalRenderItem
): number | undefined {
  const stop = journal.stopMarks.latest()
  const turnId = readAgentJournalTurn(item.body)?.turnId
  const stoppedAt = stop && turnId !== undefined && stop.event.turnId === turnId ? stop.event.at : 0
  const fence = journal.itemFence(item.itemId)
  const providerAt = fence === undefined ? 0 : (journal.lastProviderActivityAt(fence) ?? 0)
  return Math.max(stoppedAt, providerAt) || undefined
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
  journal: Pick<AgentSessionJournal, 'itemFence' | 'stopMarks' | 'lastProviderActivityAt'>,
  /** A runtime replacement proves it for every owner that runtime held, a death only for its own. */
  replaced?: AgentSessionReplacedRuntime
): JournalLifecycleMutationInput[] {
  return items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    if (turn?.state !== 'unverifiable') {
      return []
    }
    const fence = journal.itemFence(item.itemId)
    const liveAt = lastProvenTurnLiveAt(journal, item)
    const verdict =
      evidence?.ownerFence !== undefined && fence === evidence.ownerFence
        ? turnVerdictFromDeathEvidence(evidence, fence, liveAt)
        : turnVerdictFromReplacedRuntime(replaced, fence, liveAt)
    return verdict.state === 'interrupted' ? turnLifecycleRevision(item, turn, verdict) : []
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
        ? turnLifecycleRevision(item, turn, interruptedTurnVerdict(exit.observedAt))
        : []
    })
  ]
}

/** The calls those settles closed with no proof, revised by the same proof: each only when it names
 *  the owner that wrote the call, so a call that failed on its own stays failed. */
export function provenUnverifiedToolCallRevisions(
  items: readonly AgentJournalRenderItem[],
  evidence: AgentSessionDeathEvidence | null | undefined,
  journal: Pick<AgentSessionJournal, 'itemFence'>,
  replaced?: AgentSessionReplacedRuntime
): JournalLifecycleMutationInput[] {
  const ownerFence = evidence?.ownerFence
  const proven = (fence: number | undefined) =>
    fence !== undefined &&
    (fence === ownerFence || (replaced !== undefined && fence <= replaced.fence))
  return items.flatMap((item): JournalLifecycleMutationInput[] => {
    return item.body.kind === 'tool-call' &&
      isUnverifiedEndAgentJournalToolCall(item.body) &&
      proven(journal.itemFence(item.itemId))
      ? [
          {
            kind: 'item',
            itemId: item.itemId,
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
  return [
    {
      kind: 'item',
      itemId: item.itemId,
      body: agentJournalTurnBody(settledLifecycle(turn, verdict)),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  ]
}

/** The verdict replaces the previous end and preserves fields this build does not know. */
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
  if (
    verdict.state !== 'interrupted' ||
    verdict.completedAt === undefined ||
    !Number.isFinite(verdict.completedAt) ||
    verdict.completedAt <= 0
  ) {
    return { ...kept, state: verdict.state }
  }
  // A renewal can predate the turn, which started with its owner alive; it never ends before that.
  const began = Math.max(lifecycle.requestedAt ?? 0, lifecycle.startedAt ?? 0)
  return { ...kept, ...interruptedTurnVerdict(Math.max(verdict.completedAt, began)) }
}
