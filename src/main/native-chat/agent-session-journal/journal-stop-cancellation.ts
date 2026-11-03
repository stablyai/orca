import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalSubmissionProvenUnwritten } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'
import type { JournalReducerState } from './journal-reducer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { turnOpeningClientId, type JournalCancellationTarget } from './journal-cancellation-targets'
import type { JournalStopSettle } from './queued-message-pause'

export type PendingCancellation = {
  sequence: number
  event: JournalStopEvent
  target?: JournalCancellationTarget
  observedAt?: number
  settle?: JournalStopSettle
}

export function stopIsPersonal(reason: JournalStopEvent['reason']): boolean {
  return reason === 'user-stop' || reason === 'user-close'
}

function sameExecution(a: JournalCancellationTarget, b: JournalCancellationTarget): boolean {
  return (
    a.ownerFence === b.ownerFence &&
    ((a.turnId !== undefined && a.turnId === b.turnId) ||
      (a.clientMessageId !== undefined && a.clientMessageId === b.clientMessageId))
  )
}

export function executionCancellation(
  state: Pick<JournalReducerState, 'queuePauseMarks'>,
  turnId: string | null
): PendingCancellation | undefined {
  return state.queuePauseMarks.pendingCancellations?.find((entry) =>
    turnId === null ? entry.settle?.settling === true : entry.target?.turnId === turnId
  )
}

/** The queue boundary never supplies execution ownership. */
export function recordStopCancellations(
  state: JournalReducerState,
  row: JournalTombstoneRow
): void {
  const event = row.stopEvent
  if (!event || !stopIsPersonal(event.reason)) {
    return
  }
  const targets =
    event.targets ??
    (event.turnId === undefined
      ? []
      : state.derivedTurnScope.cancellations.capture(row.fence, event.turnId))
  for (const target of targets) {
    const pending = (state.queuePauseMarks.pendingCancellations ??= [])
    const previous = pending.find((entry) => entry.target && sameExecution(entry.target, target))
    if (previous) {
      previous.sequence = row.seq
      previous.observedAt = Math.max(previous.observedAt ?? previous.event.at, event.at)
    } else {
      const { targets: _targets, ...saved } = event
      pending.push({ sequence: row.seq, event: saved, target, observedAt: event.at })
    }
  }
}

function keepCancellations(
  state: Pick<JournalReducerState, 'queuePauseMarks'>,
  keep: (entry: PendingCancellation) => boolean
): void {
  const kept = state.queuePauseMarks.pendingCancellations?.filter(keep)
  if (kept?.length) {
    state.queuePauseMarks.pendingCancellations = kept
  } else {
    delete state.queuePauseMarks.pendingCancellations
  }
}

/** Provider identity joins only the captured opener in the same execution. */
export function foldCancellationTurn(
  state: JournalReducerState,
  body: AgentJournalItemBody,
  ownerFence: number
): void {
  const turn = readAgentJournalTurn(body)
  if (!turn) {
    return
  }
  const opener = turnOpeningClientId(state, turn.userItemId)
  for (const entry of state.queuePauseMarks.pendingCancellations ?? []) {
    if (
      entry.target?.ownerFence === ownerFence &&
      opener !== undefined &&
      entry.target.clientMessageId === opener
    ) {
      entry.target.turnId = turn.turnId
    }
  }
  if (turn.state !== 'running' && turn.state !== 'unverifiable') {
    retireCancellation(state, turn.turnId, opener)
  }
}

export function retireCancellation(
  state: Pick<JournalReducerState, 'queuePauseMarks'>,
  turnId?: string,
  clientMessageId?: string
): void {
  keepCancellations(
    state,
    (entry) =>
      !(turnId !== undefined && entry.target?.turnId === turnId) &&
      !(
        clientMessageId !== undefined &&
        entry.target?.clientMessageId === clientMessageId &&
        (turnId !== undefined || entry.target.turnId === undefined)
      )
  )
}

/** Rebuilds carry evidence with retained executions, never by replaying the queue's Stop. */
export function carryStopCancellations(
  previous: JournalReducerState,
  state: JournalReducerState,
  items: Iterable<AgentJournalRenderItem>
): void {
  const survivors = new Map<string, JournalCancellationTarget>()
  for (const item of items) {
    const turn = readAgentJournalTurn(item.body)
    if (turn && (turn.state === 'running' || turn.state === 'unverifiable')) {
      const target = state.derivedTurnScope.cancellations.turn(turn.turnId)
      if (target) {
        survivors.set(turn.turnId, target)
      }
    }
  }
  const kept = (previous.queuePauseMarks.pendingCancellations ?? []).flatMap((entry) => {
    const target = entry.target
    if (!target) {
      return []
    }
    const retained = target.turnId !== undefined ? survivors.get(target.turnId) : undefined
    const id = target.clientMessageId
    const key = id === undefined ? undefined : agentJournalSubmissionKey(id)
    const source = id === undefined ? undefined : previous.submissions.get(id)
    const openerSurvives =
      target.turnId === undefined &&
      key !== undefined &&
      state.items.has(key) &&
      source !== undefined &&
      !agentJournalSubmissionProvenUnwritten(source) &&
      previous.itemFences.get(key) === state.itemFences.get(key)
    if (!(retained && sameExecution(target, retained)) && !openerSurvives) {
      return []
    }
    if (openerSurvives && source && id !== undefined) {
      state.submissions.set(id, { ...source })
      if (source.providerItemId) {
        state.aliases.set(source.providerItemId, agentJournalSubmissionKey(id))
      }
      const receipt = previous.receipts.get(id)
      if (receipt) {
        state.receipts.set(id, receipt)
      }
      state.derivedTurnScope.cancellations.retainOpener(id, target.ownerFence)
    }
    const { settle: _settle, ...saved } = entry
    return [{ ...saved, event: { ...saved.event }, target: { ...target } }]
  })
  if (kept.length) {
    state.queuePauseMarks.pendingCancellations = kept
  } else {
    delete state.queuePauseMarks.pendingCancellations
  }
}

export function normalizeStopCancellations(state: JournalReducerState): void {
  const converted = (state.queuePauseMarks.pendingCancellations ?? []).flatMap((entry) => {
    const target =
      entry.target ??
      (entry.event.turnId === undefined
        ? undefined
        : state.derivedTurnScope.cancellations.turn(entry.event.turnId))
    return target ? [{ ...entry, target: { ...target } }] : []
  })
  const latest = state.queuePauseMarks.latestStop
  const target =
    latest?.event.turnId === undefined
      ? undefined
      : state.derivedTurnScope.cancellations.turn(latest.event.turnId)
  if (
    latest &&
    stopIsPersonal(latest.event.reason) &&
    target &&
    !converted.some((entry) => sameExecution(entry.target, target))
  ) {
    converted.push({
      sequence: latest.sequence,
      event: latest.event,
      target: { ...target },
      observedAt: latest.event.at
    })
  }
  if (converted.length) {
    state.queuePauseMarks.pendingCancellations = converted
  } else {
    delete state.queuePauseMarks.pendingCancellations
  }
}
