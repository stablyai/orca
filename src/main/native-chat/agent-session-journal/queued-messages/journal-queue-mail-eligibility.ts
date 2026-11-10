import type { JournalSubmissionConsume } from '../journal-store-contracts'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from '../input-order/journal-input-order'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalManualStop } from './queued-message-pause-marks'
import type { QueuedMessageRow } from './queued-message-table'

type QueueWalk = { key: string; first: QueuedMessageRow | null; pastMail?: QueuedMessageRow | null }
const walks = new WeakMap<object, Map<string, QueueWalk>>()

/** Automatic claim skips held rows; only an edit lease is a barrier. Mail keeps its owner's order. */
export function nextEligibleQueuedCard(input: {
  state: JournalReducerState
  floor: AgentJournalCursor | null
  get: (messageId: string) => QueuedMessageRow | null
  editHeld: (messageId: string) => boolean
  revisions: readonly unknown[]
  unavailable: ((card: QueuedMessageRow) => boolean) | undefined
  steer?: boolean
  automatic?: boolean
}): QueuedMessageRow | null {
  const order = journalInputOrder(input.state)
  order.cards.ensure(input.state, input.floor)
  const state = input.state
  const marks = state.queuePauseMarks
  const key = [
    ...input.revisions,
    order.cards.version(),
    input.steer,
    order.cards.failureHolds(),
    state.latestAcceptedTurnSequence,
    journalInputOrder(state).latestPersonAcceptedSequence(),
    journalManualStop(marks)?.sequence,
    marks.resumedSequence,
    marks.reopenedSequence,
    marks.cleared?.sequence,
    marks.cleared?.lifted,
    input.floor?.epoch,
    input.floor?.sequence
  ].join(':')
  let modes = walks.get(order.cards)
  if (!modes) {
    modes = new Map()
    walks.set(order.cards, modes)
  }
  const mode = `${input.steer === true}:${input.automatic !== false}`
  let walk = modes.get(mode)
  const find = (after?: QueuedMessageRow): QueuedMessageRow | null => {
    for (const row of order.cards.live(after)) {
      const card = input.get(row.messageId) ?? row
      if (input.editHeld(card.messageId)) {
        break
      }
      if (card.state !== 'waiting' || card.holdReason !== null || order.cards.paused(card)) {
        continue
      }
      const mail = orchestrationMailNotice(card.body.from)
      if (input.steer && (card.body.command || (!mail && card.deliveryMode !== 'steer'))) {
        continue
      }
      if (!after || !mail) {
        return card
      }
    }
    return null
  }
  if (!walk || walk.key !== key) {
    walk = { key, first: find() }
    modes.set(mode, walk)
  }
  const first = walk.first
  // Ownership is external: ask afresh, and walk past mail only when its owner cannot take it.
  if (first && orchestrationMailNotice(first.body.from) && input.unavailable?.(first)) {
    if (walk.pastMail === undefined) {
      walk.pastMail = find(first)
    }
    return walk.pastMail
  }
  return first
}

/** Automatic consumption validates the same current selection on the journal write lane. */
export function assertQueuedCardConsumable(
  input: JournalSubmissionConsume & { consumedAs: string; fingerprint: string },
  card: QueuedMessageRow | null,
  next: () => QueuedMessageRow | null
): void {
  if (
    card !== null &&
    card.state === input.expect &&
    card.fingerprint === input.fingerprint &&
    input.consumedAs !== input.messageId &&
    (!input.yieldsToPause || next()?.messageId === input.messageId)
  ) {
    return
  }
  throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
}
