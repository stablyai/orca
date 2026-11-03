import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalCancellationTarget } from './journal-cancellation-targets'
import { restoreJournalCancellationTargets } from './journal-cancellation-targets'
import type { JournalStopSettle } from './queued-message-pause'
import type { AcceptedInterruption, ExecutionInterruption } from './journal-execution-interruption'

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
export function activeCancellations(
  state: Pick<JournalReducerState, 'derivedTurnScope'>
): PendingCancellation[] {
  return state.derivedTurnScope.cancellations.pending()
}
export function executionCancellation(
  state: Pick<JournalReducerState, 'derivedTurnScope'>,
  turnId: string | null
): PendingCancellation | undefined {
  return activeCancellations(state).find((entry) =>
    turnId === null ? entry.settle?.settling === true : entry.target?.turnId === turnId
  )
}

/** Accepted control is retained on its execution; neither queue replacement nor feedback owns it. */
export function recordStopCancellations(
  state: JournalReducerState,
  row: JournalTombstoneRow
): void {
  const event = row.stopEvent
  if (!event || (event.reason !== 'user-stop' && event.reason !== 'user-close')) {
    return
  }
  const index = state.derivedTurnScope.cancellations
  const targets =
    event.targets ?? (event.turnId === undefined ? [] : index.capture(row.fence, event.turnId))
  for (const target of targets) {
    const anchorId = index.anchor(target)
    const anchor = anchorId === undefined ? undefined : state.items.get(anchorId)
    if (!anchor) {
      continue
    }
    const { targets: _targets, ...saved } = event
    const request: AcceptedInterruption = {
      epoch: row.epoch,
      sequence: row.seq,
      event: { ...saved, reason: event.reason }
    }
    const previous =
      anchor.executionInterruption?.target.ownerFence === target.ownerFence
        ? anchor.executionInterruption
        : undefined
    const fact: ExecutionInterruption = {
      owner: previous?.owner ?? {
        epoch: row.epoch,
        sequence: anchor.sequence,
        ...(anchor.sequenceIndex === undefined ? {} : { sequenceIndex: anchor.sequenceIndex }),
        itemId: anchor.itemId,
        ownerFence: target.ownerFence
      },
      target: previous?.target ?? { ...target },
      first: previous?.first ?? request,
      ...(previous?.userStop || event.reason === 'user-stop'
        ? { userStop: previous?.userStop ?? request }
        : {}),
      observedAt: Math.max(previous?.observedAt ?? event.at, event.at),
      sequence: row.seq
    }
    state.items.set(anchor.itemId, { ...anchor, executionInterruption: fact })
    index.refresh(state, anchor.itemId)
  }
}

export function retireCancellation(
  state: JournalReducerState,
  turnId?: string,
  clientMessageId?: string
): void {
  state.derivedTurnScope.cancellations.remove(turnId, clientMessageId)
}

/** Both epoch builders carry the same retained owner graph, including terminal history. */
export function carryStopCancellations(
  previous: JournalReducerState,
  state: JournalReducerState,
  _items: Iterable<AgentJournalRenderItem>
): void {
  for (const item of previous.items.values()) {
    const fact = item.executionInterruption
    if (!fact) {
      continue
    }
    const target =
      fact.target.turnId === undefined
        ? undefined
        : state.derivedTurnScope.cancellations.turn(fact.target.turnId)
    if (fact.target.turnId !== undefined && !target) {
      if (fact.target.clientMessageId !== undefined) {
        state.derivedTurnScope.cancellations.retireSubmission(state, fact.target.clientMessageId)
      }
      continue
    }
    const anchorId = target
      ? state.derivedTurnScope.cancellations.anchor(target)
      : fact.target.clientMessageId === undefined
        ? undefined
        : agentJournalSubmissionKey(fact.target.clientMessageId)
    const anchor = anchorId === undefined ? undefined : state.items.get(anchorId)
    if (!anchor || (target && target.ownerFence !== fact.target.ownerFence)) {
      continue
    }
    const moved = { ...fact, target: target ? { ...target } : { ...fact.target } }
    state.items.set(anchor.itemId, { ...anchor, executionInterruption: moved })
    const id = fact.target.clientMessageId
    if (fact.target.turnId === undefined && id !== undefined) {
      const submission = previous.submissions.get(id)
      if (submission) {
        state.submissions.set(id, { ...submission })
      }
      const receipt = previous.receipts.get(id)
      if (receipt) {
        state.receipts.set(id, { ...receipt })
      }
      if (submission?.providerItemId) {
        state.aliases.set(submission.providerItemId, agentJournalSubmissionKey(id))
      }
    }
  }
  restoreJournalCancellationTargets(state)
}

/** Legacy fields are accepted once, then rewritten into canonical owners rather than active debt. */
export function normalizeStopCancellations(state: JournalReducerState): void {
  const entries = [...(state.queuePauseMarks.pendingCancellations ?? [])]
  const latest = state.queuePauseMarks.latestStop
  if (latest?.event.turnId !== undefined && stopIsPersonal(latest.event.reason)) {
    if (latest.event.targets !== undefined) {
      entries.push(...latest.event.targets.map((target) => ({ ...latest, target })))
    } else {
      entries.push(latest)
    }
  }
  for (const entry of entries) {
    const target =
      entry.target ??
      (entry.event.turnId === undefined
        ? undefined
        : legacyStopTarget(state, entry.event.turnId, entry.sequence))
    const anchorId = target && state.derivedTurnScope.cancellations.anchor(target)
    const canonical =
      target?.turnId === undefined
        ? undefined
        : state.derivedTurnScope.cancellations.turn(target.turnId)
    if (
      !target ||
      (canonical && canonical.ownerFence !== target.ownerFence) ||
      anchorId === undefined ||
      state.items.get(anchorId)?.executionInterruption
    ) {
      continue
    }
    recordStopCancellations(state, {
      kind: 'tombstone',
      v: 4,
      epoch: state.epoch,
      seq: entry.sequence,
      fence: target.ownerFence,
      ts: entry.event.at,
      itemId: 'legacy-stop',
      revision: 0,
      stopEvent: { ...entry.event, targets: [target] }
    })
  }
  delete state.queuePauseMarks.pendingCancellations
}

function legacyStopTarget(state: JournalReducerState, turnId: string, sequence: number) {
  const index = state.derivedTurnScope.cancellations
  const target = index.turn(turnId)
  const itemId = index.turnItem(turnId)
  const item = itemId === undefined ? undefined : state.items.get(itemId)
  return item &&
    item.sequence <= sequence &&
    state.itemFences.get(item.itemId) === target?.ownerFence
    ? target
    : undefined
}
