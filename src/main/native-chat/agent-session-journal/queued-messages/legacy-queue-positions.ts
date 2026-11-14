import { compareQueuedRows } from '../input-order/journal-queued-row-index'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../journal-store'

type QueuedMessagePositionMove = { messageId: string; position: number }

/** Merge logical places once, then materialize finite ranks with the first successful keep. */
export function legacyQueuePositions(
  journal: AgentSessionJournal,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[],
  unrun: boolean
): { placed: Map<string, number>; moves: QueuedMessagePositionMove[] } {
  const cards = [
    ...new Map(
      [
        ...[...journal.queuedMessages.displayState().queue.cards.values()].filter(
          (card) => card.state !== 'withdrawn'
        ),
        ...journal.queuedMessages.list()
      ].map((card) => [card.messageId, card])
    ).values()
  ].sort(compareQueuedRows)
  const kept = (id: string) => journal.inputOrder.keptCard(id)
  const { epoch } = journal.physicalCursor()
  const state = journal.queuedMessages.displayState()
  const forcedBatch = batch.some(({ submission }) =>
    journal.inputOrder.legacy!.forced(submission.clientMessageId)
  )
  const earlier: string[] = []
  const rest: (typeof cards)[number][] = []
  const cardsById = new Map(cards.map((card) => [card.messageId, card]))
  const explicitHeads = new Map(
    batch.flatMap(({ submission }) => {
      const id = submission.origin === 'client' ? submission.queuedMessageId : undefined
      const card = id ? journal.queuedMessages.get(id) : null
      if (id && card?.consumedAs === submission.clientMessageId) {
        cardsById.set(id, card)
        return [[submission.clientMessageId, id] as const]
      }
      return []
    })
  )
  const explicit = new Set(explicitHeads.values())
  for (const card of cards) {
    if (explicit.has(card.messageId)) {
      continue
    }
    if (
      card.state === 'waiting' &&
      ((unrun && kept(card.messageId)) ||
        (!forcedBatch && card.queuedAt && card.queuedAt.epoch !== epoch))
    ) {
      earlier.push(card.messageId)
    } else {
      rest.push(card)
    }
  }
  const at = new Map<number, string[]>()
  const head: string[] = []
  const firstCut = batch
    .flatMap(
      ({ submission }) =>
        journal.inputOrder.legacy!.place(submission.clientMessageId)?.context.cut ?? []
    )
    .reduce((a, b) => Math.min(a, b), Infinity)
  let previousBoundary = 0
  for (let i = 0; i < rest.length; i++) {
    if (
      rest[i].state === 'waiting' &&
      kept(rest[i].messageId) &&
      (journal.inputOrder.legacy!.lineage.cards.get(rest[i].messageId)?.introduced ?? -Infinity) <
        firstCut
    ) {
      previousBoundary = i + 1
    }
  }
  for (const { submission, body } of batch) {
    const id = body ? submission.clientMessageId : explicitHeads.get(submission.clientMessageId)
    if (!id || (body && kept(id))) {
      continue
    }
    if (!body && previousBoundary > 0) {
      head.push(id)
      continue
    }
    const after = journal.inputOrder.legacy!.forced(submission.clientMessageId)
      ? journal.inputOrder.legacy!.predecessors(state, submission.clientMessageId).position
      : -Infinity
    let low = 0,
      high = rest.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (rest[mid].position <= after) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    const boundary = Math.max(previousBoundary, low)
    previousBoundary = boundary
    const bucket = at.get(boundary) ?? []
    bucket.push(id)
    at.set(boundary, bucket)
  }
  const order = [...earlier, ...head]
  for (let i = 0; i <= rest.length; i++) {
    order.push(...(at.get(i) ?? []))
    if (i < rest.length) {
      order.push(rest[i].messageId)
    }
  }
  const placed = new Map(order.map((id, index) => [id, index]))
  return {
    placed,
    moves: [...cardsById.values()].flatMap((card) => {
      const position = placed.get(card.messageId)!
      return position === card.position ? [] : [{ messageId: card.messageId, position }]
    })
  }
}
