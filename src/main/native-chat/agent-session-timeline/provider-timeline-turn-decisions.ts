import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput,
  ProviderTimelineItemWrite,
  ProviderTimelineResolvedWrite
} from './provider-timeline-decision'
import {
  providerKey,
  providerTimelineTurnRowState,
  type ProviderTimelineTurnRef
} from './provider-timeline-rows'
import {
  providerTimelineSettlement,
  runningProviderTimelineTurns,
  type ProviderTimelineTurnEnd
} from './provider-timeline-settlement'
import type {
  ProviderTimelineOpenTurn,
  ProviderTimelinePendingInput
} from './provider-timeline-state'

const TURN_ROW_RESERVED_BYTES = 64 * 1024

export function decideTurnOpen(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.open' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const open = state.open
  // New turns supersede open work, including externally stopped turns awaiting provider end.
  const superseded = open ?? state.stopped
  if (event.turn === undefined && open) {
    return { dropped: 'turn-duplicate' }
  }
  const turn = context.rows.turn(
    event.turn === undefined ? context.rows.minted('t', input.serial()) : providerKey(event.turn)
  )
  const held = journal ? providerTimelineTurnRowState(journal, turn.itemId) : 'absent'
  if (open?.itemId === turn.itemId || held === 'running') {
    return { dropped: 'turn-duplicate' }
  }
  if (held === 'settled') {
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
  const write: ProviderTimelineResolvedWrite = {
    identity: turn.identity,
    body: agentJournalTurnBody(running)
  }
  return {
    ...(superseded
      ? {
          settle: {
            what: 'turn-superseded',
            resolve: (journal) =>
              providerTimelineSettlement(
                journal,
                { turnItemId: superseded.itemId },
                {
                  turns: [superseded],
                  end: { state: 'interrupted', completedAt: event.at, outcome: 'superseded' }
                }
              )
          }
        }
      : {}),
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        // Stamp turn start rather than append latency.
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true, observedAt: event.at },
        // Never regress an existing turn to running.
        resolve: (at) => (at.itemBody(turn.itemId) === null ? write : null)
      }
    ],
    commit: (next) => {
      if (superseded) {
        next.endTurn(superseded)
      }
      if (pending) {
        next.inputs = next.inputs.filter((each) => each !== pending)
      }
      next.open = { ...turn, running }
    }
  }
}

export function decideTurnEnd(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.end' }>
): ProviderTimelineDecision {
  const { state, journal } = input
  const turn =
    event.turn === undefined
      ? (state.open ?? state.stopped)
      : input.context.rows.turn(providerKey(event.turn))
  if (!turn) {
    return { dropped: 'no-turn' }
  }
  // Known ended turns still need residual-work settlement without rewriting the turn.
  const known =
    state.open?.itemId === turn.itemId ||
    state.latest?.itemId === turn.itemId ||
    !journal ||
    providerTimelineTurnRowState(journal, turn.itemId) !== 'absent'
  if (!known) {
    return { dropped: 'turn-unknown' }
  }
  const end: ProviderTimelineTurnEnd = {
    state: event.state,
    completedAt: event.at,
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
  }
  return {
    ends: { turnItemId: turn.itemId, current: !state.open || state.open.itemId === turn.itemId },
    settle: {
      what: 'turn-end',
      resolve: (journal) =>
        providerTimelineSettlement(journal, { turnItemId: turn.itemId }, { turns: [turn], end })
    },
    commit: (next) => next.endTurn(turn)
  }
}

/** External settlement ends text/prompts; calls wait for provider end, a newer turn or session end. */
export function decideTurnSettled(
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.settled' }>
): ProviderTimelineDecision {
  const { turn } = event
  return {
    ends: { turnItemId: turn.itemId, current: true },
    settle: {
      what: 'turn-settled',
      resolve: (journal) => providerTimelineSettlement(journal, { turnItemId: turn.itemId })
    },
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
  const { state, journal, context } = input
  const open = state.open
  const turn = named === undefined ? null : context.rows.turn(providerKey(named))
  if (turn && turn.itemId !== open?.itemId) {
    if (journal && providerTimelineTurnRowState(journal, turn.itemId) !== 'absent') {
      return {}
    }
    return { commit: (next) => next.wait({ ...message, turnItemId: turn.itemId }) }
  }
  if (!open) {
    return { commit: (next) => next.wait(message) }
  }
  const opener =
    (journal && readAgentJournalTurn(journal.itemBody(open.itemId) ?? undefined)?.userItemId) ??
    open.running.userItemId
  if (opener !== open.itemId) {
    return {}
  }
  const running = { ...open.running, ...message }
  return {
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true },
        resolve: (at) => reviseOpener(at, open, message)
      }
    ],
    commit: (next) => {
      if (next.open?.itemId === open.itemId) {
        next.open = { ...next.open, running }
      }
    }
  }
}

/** Set openers only on running, unclaimed turns; preserve all other journal fields. */
function reviseOpener(
  journal: StructuredAgentSessionTransitionJournal,
  open: ProviderTimelineOpenTurn,
  message: Omit<ProviderTimelinePendingInput, 'turnItemId'>
): ProviderTimelineResolvedWrite | null {
  const row = readAgentJournalTurn(journal.itemBody(open.itemId) ?? undefined)
  if (row?.state !== 'running' || row.userItemId !== open.itemId) {
    return null
  }
  const target = { identity: open.identity }
  const write = {
    lifecycle: agentJournalTurnBody({ ...row, ...message }),
    // Recheck in revision even though the snapshot already showed running.
    onlyWhileRunning: true as const
  }
  return resolveAgentJournalTurnRowWrite(
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}

export function decideSessionEnd(
  _input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'session.ended' }>
): ProviderTimelineDecision {
  return {
    settle: {
      what: 'session-end',
      recovered: true,
      resolve: (journal) =>
        providerTimelineSettlement(journal, 'session', {
          turns: runningProviderTimelineTurns(journal),
          end: event.verdict,
          ...(event.endedAt !== undefined ? { lostAt: event.endedAt } : {})
        })
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
    resolve: (journal) =>
      resolveAgentJournalTurnRowWrite(
        journal,
        target,
        write,
        agentJournalTurnRowReservedBytes(target, write)
      )
  }
  return { writes: [usage] }
}
