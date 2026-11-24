import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './projection/journal-reducer'
import { memoryJournalMap } from './journal-memory-collections'
import { journalInputOrder } from './input-order/journal-input-order'
import { compareQueuedRows } from './input-order/journal-queued-row-index'
import { unsentSendKeptAsCard } from './queued-messages/journal-unsent-send-hold'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

/** Materialize old places once while unready; ready SQL rows never own a legacy decoder. */
export function placeImportedLegacyQueue(
  state: JournalReducerState,
  cards: Map<string, QueuedMessageRow>,
  personal: (submission: AgentJournalSubmission) => boolean
): void {
  const owner = journalInputOrder(state)
  const legacy = owner.legacy
  if (!legacy) {
    return
  }
  const batch = [...memoryJournalMap(state.submissions).values()]
    .filter(isQueuedAgentJournalSubmission)
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
    .map((submission) => ({
      submission,
      body: unsentSendKeptAsCard(
        submission,
        state.items.get(agentJournalSubmissionKey(submission.clientMessageId))?.body ?? null
      )
    }))
  if (batch.length === 0) {
    return
  }
  const placed = legacyQueuePositions(state, cards, batch)
  for (const [id, position] of placed) {
    const card = cards.get(id)
    if (card) {
      cards.set(id, { ...card, position })
    }
  }
  for (const { submission, body } of batch) {
    if (!body || cards.has(submission.clientMessageId)) {
      continue
    }
    cards.set(submission.clientMessageId, {
      messageId: submission.clientMessageId,
      body,
      position: placed.get(submission.clientMessageId)!,
      fingerprint: agentSessionSendBodyFingerprint(state.sessionId, body),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: state.epoch, sequence: submission.submittedSequence ?? 0 },
      deliveryMode: 'queue',
      unattended: !personal(submission),
      ...(submission.options ? { options: submission.options } : {})
    })
  }
}

function legacyQueuePositions(
  state: JournalReducerState,
  allCards: ReadonlyMap<string, QueuedMessageRow>,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[]
): Map<string, number> {
  const owner = journalInputOrder(state)
  const legacy = owner.legacy!
  const cards = [...allCards.values()]
    .filter((card) => card.state !== 'withdrawn')
    .sort(compareQueuedRows)
  const forcedBatch = batch.some(({ submission }) => legacy.forced(submission.clientMessageId))
  const explicitHeads = new Map(
    batch.flatMap(({ submission }) => {
      const id = submission.origin === 'client' ? submission.queuedMessageId : undefined
      return id && allCards.get(id)?.consumedAs === submission.clientMessageId
        ? [[submission.clientMessageId, id] as const]
        : []
    })
  )
  const explicit = new Set(explicitHeads.values())
  const earlier: string[] = []
  const rest: QueuedMessageRow[] = []
  for (const card of cards) {
    if (explicit.has(card.messageId)) {
      continue
    }
    if (
      card.state === 'waiting' &&
      !forcedBatch &&
      card.queuedAt &&
      card.queuedAt.epoch !== state.epoch
    ) {
      earlier.push(card.messageId)
    } else {
      rest.push(card)
    }
  }
  const at = new Map<number, string[]>()
  const head: string[] = []
  const firstCut = batch
    .flatMap(({ submission }) => legacy.place(submission.clientMessageId)?.context.cut ?? [])
    .reduce((a, b) => Math.min(a, b), Infinity)
  let previousBoundary = 0
  for (let i = 0; i < rest.length; i++) {
    if (
      rest[i].state === 'waiting' &&
      owner.keptCard(rest[i].messageId) &&
      (legacy.lineage.cards.get(rest[i].messageId)?.introduced ?? -Infinity) < firstCut
    ) {
      previousBoundary = i + 1
    }
  }
  for (const { submission, body } of batch) {
    const id = body ? submission.clientMessageId : explicitHeads.get(submission.clientMessageId)
    if (!id || (body && owner.keptCard(id))) {
      continue
    }
    if (!body && previousBoundary > 0) {
      head.push(id)
      continue
    }
    const after = legacy.forced(submission.clientMessageId)
      ? legacy.predecessors(state, submission.clientMessageId).position
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
  return new Map(order.map((id, index) => [id, index]))
}
