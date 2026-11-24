import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { agentJournalTurnRowReservedBytes } from './agent-journal-turn-row-revision'
import { providerTimelineRequest } from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput,
  ProviderTimelineItemWrite
} from './provider-timeline-decision'
import { providerKey, type ProviderTimelineTurnRef } from './provider-timeline-rows'
import type { ProviderTimelineTurnEnd } from './provider-timeline-settlement'
import type {
  ProviderTimelineOpenTurn,
  ProviderTimelinePendingInput
} from './provider-timeline-state'
import type { ProviderTimelineSettlementResolution } from './provider-timeline-writer-resolution'

const TURN_ROW_RESERVED_BYTES = 64 * 1024

export function decideTurnOpen(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.open' }>
): ProviderTimelineDecision {
  const { state, context } = input
  const open = state.open
  // New turns supersede open work, including externally stopped turns awaiting provider end.
  const superseded = open ?? state.stopped
  if (event.turn === undefined && open) {
    return { dropped: 'turn-duplicate' }
  }
  const turn = context.rows.turn(
    event.turn === undefined ? context.rows.minted('t', input.serial()) : providerKey(event.turn)
  )
  if (open?.itemId === turn.itemId) {
    return { dropped: 'turn-duplicate' }
  }
  // This producer already ended it; the writer refuses reopening any other settled turn.
  if (state.latest?.itemId === turn.itemId) {
    return { dropped: 'turn-settled' }
  }
  const pending = state.opener(turn.itemId)
  const running: AgentJournalTurnLifecycle = {
    turnId: turn.turnId,
    state: 'running',
    userItemId: pending?.userItemId ?? turn.itemId,
    startedAt: event.at,
    ...(pending ? { requestedAt: pending.requestedAt } : {})
  }
  const opened: ProviderTimelineOpenTurn = { ...turn, running }
  return {
    ...(superseded
      ? {
          settle: {
            what: 'turn-superseded',
            resolution: turnSettlement(input, superseded, {
              state: 'interrupted',
              completedAt: event.at,
              outcome: 'superseded'
            })
          }
        }
      : {}),
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        // Stamp turn start rather than append latency.
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true, observedAt: event.at },
        resolution: {
          kind: 'turn-open',
          identity: turn.identity,
          body: agentJournalTurnBody(running)
        },
        // Another writer already ended this turn; later events must not reopen it.
        onResolved: (outcome) => {
          if (
            outcome.kind === 'dropped' &&
            outcome.reason === 'turn-settled' &&
            state.open === opened
          ) {
            state.endTurn(turn)
          }
        }
      }
    ],
    commit: (next) => {
      if (superseded) {
        next.endTurn(superseded)
      }
      if (pending) {
        next.inputs = next.inputs.filter((each) => each !== pending)
      }
      next.open = opened
    }
  }
}

function turnSettlement(
  input: ProviderTimelineDecisionInput,
  turn: ProviderTimelineTurnRef,
  end?: ProviderTimelineTurnEnd
): ProviderTimelineSettlementResolution {
  return {
    kind: 'timeline-settlement',
    scope: { turnItemId: turn.itemId },
    ...(end ? { ending: { turns: [turn.identity], end } } : {}),
    keep: input.state
      .liveRequests(turn.itemId)
      .map((request) => providerTimelineRequest(input.context, request))
  }
}

export function decideTurnEnd(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.end' }>
): ProviderTimelineDecision {
  const { state } = input
  const turn =
    event.turn === undefined
      ? (state.open ?? state.stopped)
      : input.context.rows.turn(providerKey(event.turn))
  if (!turn) {
    return { dropped: 'no-turn' }
  }
  // Known ended turns still need residual-work settlement; the writer rewrites only running rows.
  const end: ProviderTimelineTurnEnd = {
    state: event.state,
    completedAt: event.at,
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
  }
  return {
    ends: { turnItemId: turn.itemId, current: !state.open || state.open.itemId === turn.itemId },
    settle: { what: 'turn-end', resolution: turnSettlement(input, turn, end) },
    commit: (next) => next.endTurn(turn)
  }
}

/** External settlement ends text/prompts; calls wait for provider end, a newer turn or session end. */
export function decideTurnSettled(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.settled' }>
): ProviderTimelineDecision {
  const { turn } = event
  return {
    ends: { turnItemId: turn.itemId, current: true },
    // Live requests end by their own answer or withdrawal, which Stop sends first.
    settle: { what: 'turn-settled', resolution: turnSettlement(input, turn) },
    commit: (next) => next.stopTurn(turn)
  }
}

export function decideInput(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'input.accepted' }>
): ProviderTimelineDecision {
  return decideOpener(
    input,
    {
      userItemId: agentJournalSubmissionKey(event.clientMessageId),
      requestedAt: event.requestedAt
    },
    event.join?.turn
  )
}

/** Bind the named turn, then an unclaimed open turn, otherwise the next to open. */
function decideOpener(
  input: ProviderTimelineDecisionInput,
  message: Omit<ProviderTimelinePendingInput, 'turnItemId'>,
  named: string | undefined
): ProviderTimelineDecision {
  const { state, context } = input
  const open = state.open
  const turn = named === undefined ? null : context.rows.turn(providerKey(named))
  if (turn && turn.itemId !== open?.itemId) {
    // A turn that already opened ignores its waiting opener.
    return { commit: (next) => next.wait({ ...message, turnItemId: turn.itemId }) }
  }
  if (!open) {
    return { commit: (next) => next.wait(message) }
  }
  if (open.running.userItemId !== open.itemId) {
    return {}
  }
  const running = { ...open.running, ...message }
  return {
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true },
        resolution: { kind: 'turn-opener', identity: open.identity, message }
      }
    ],
    commit: (next) => {
      if (next.open?.itemId === open.itemId) {
        next.open = { ...next.open, running }
      }
    }
  }
}

export function decideSessionEnd(
  _input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'session.ended' }>
): ProviderTimelineDecision {
  return {
    settle: {
      what: 'session-end',
      recovered: true,
      resolution: {
        kind: 'timeline-settlement',
        scope: 'session',
        ending: {
          turns: 'running',
          end: event.verdict,
          ...(event.endedAt !== undefined ? { lostAt: event.endedAt } : {})
        },
        keep: []
      }
    },
    commit: (next) => next.endSession()
  }
}

export function decideContextUsage(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'context.usage' }>
): ProviderTimelineDecision {
  const { state } = input
  const named = event.join?.turn
  const turn: ProviderTimelineTurnRef | null =
    named === undefined ? (state.open ?? state.latest) : input.context.rows.turn(providerKey(named))
  const target = turn ? { identity: turn.identity } : ({ newest: true } as const)
  const write = { contextUsage: event.usage }
  const usage: ProviderTimelineItemWrite = {
    reservedBytes: agentJournalTurnRowReservedBytes(target, write),
    lifecycle: true,
    options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
    resolution: { kind: 'turn-row', target, write }
  }
  return { writes: [usage] }
}
