// Require matching owner death or runtime-replacement proof for interrupted; otherwise retain unverifiable until proof.

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
  /** Stop events determine personal cancellation when building the row. */
  { state: 'interrupted'; completedAt?: number } | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  turnFence: number | undefined,
  /** Saved output or Stop that observed this turn running. */
  liveAt?: number
): StructuredAgentSessionTurnVerdict {
  if (!evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence === undefined) {
    // Preserve legacy ownerless evidence rules.
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
  // Bound probe-discovered death by last life evidence; client sends/recovery writes prove none.
  const lastAlive = Math.max(evidence.lastProvenAliveAt ?? evidence.observedAt, liveAt ?? 0)
  return interruptedTurnVerdict(Math.min(lastAlive, evidence.observedAt))
}

function interruptedTurnVerdict(completedAt: number): StructuredAgentSessionTurnVerdict {
  return Number.isFinite(completedAt) && completedAt > 0
    ? { state: 'interrupted', completedAt }
    : { state: 'interrupted' }
}

/** Replaced runtime loses owner transport; end at its last saved proof of life. */
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

/** Personal Stop owns these interrupted turns, suppressing provider-failure notices. */
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

export function runningTurnLifecycleRevisions(
  items: readonly AgentJournalRenderItem[],
  verdict: StructuredAgentSessionTurnVerdict
): JournalLifecycleMutationInput[] {
  return items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.state === 'running' ? turnLifecycleRevision(item, turn, verdict) : []
  })
}

/** Upgrade unverifiable only with matching owner proof, never legacy ownerless evidence. */
export function provenUnverifiableTurnRevisions(
  items: readonly AgentJournalRenderItem[],
  evidence: AgentSessionDeathEvidence | null | undefined,
  journal: Pick<AgentSessionJournal, 'itemFence' | 'stopMarks' | 'lastProviderActivityAt'>,
  /** Replacement covers all owners it held; death covers only its named owner. */
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

export type StructuredAgentSessionWatchedExit = { ownerFence: number; observedAt: number }

/** Observed exit revises matching unverified turns/calls at its own timestamp, without Stop timing. */
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

/** Revise only proof-matching calls; independent failures remain failed. */
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

/** Replace old end fields while retaining unknown fields. */
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
  // Completion cannot precede turn start, even if renewal evidence does.
  const began = Math.max(lifecycle.requestedAt ?? 0, lifecycle.startedAt ?? 0)
  return { ...kept, ...interruptedTurnVerdict(Math.max(verdict.completedAt, began)) }
}
