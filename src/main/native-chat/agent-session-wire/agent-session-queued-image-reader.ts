import {
  finishJournalSteps,
  sortJournalSteps
} from '../agent-session-journal/journal-reconstruction-steps'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission,
  type AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalRenderItem } from '../agent-session-journal/journal-render-item'
import { readPublishedQueuedMessageSteps } from './structured-agent-session-queued-publication'
export {
  queuedImageReaderEvent,
  queuedImageReaderEventSteps
} from './agent-session-queued-image-events'

export const queuedCardHoldsImage = (card: Pick<AgentSessionQueuedMessage, 'body'>): boolean =>
  card.body.blocks.some((block) => block.type === 'image-ref')

// Publication arrays are immutable; retain their derived source relation for the sent baseline.
const relations = new WeakMap<
  object,
  { ids: ReadonlyMap<string, boolean>; imageIds: ReadonlySet<string> }
>()
export function* sourceIdSteps(
  journal: AgentSessionJournal,
  cards: readonly Pick<AgentSessionQueuedMessage, 'body' | 'messageId'>[]
) {
  const cached = relations.get(cards)
  if (cached) {
    return cached
  }
  const ids = new Map<string, boolean>()
  const imageIds = new Set<string>()
  for (const card of cards) {
    yield
    if (!queuedCardHoldsImage(card)) {
      continue
    }
    const row = journal.queuedMessages.get(card.messageId)
    if (row?.state !== 'waiting' && row?.state !== 'returned') {
      continue
    }
    imageIds.add(card.messageId)
    const id = row?.recovers ?? row?.consumedAs ?? card.messageId
    const send = journal.submission(id)
    if (
      send &&
      (row?.recovers === id ||
        row?.consumedAs === id ||
        send.keptAsQueuedMessageId === card.messageId)
    ) {
      ids.set(id, send.payloadFingerprint === row.fingerprint)
    }
  }
  const result = { ids, imageIds }
  relations.set(cards, result)
  return result
}

export function sourcePresentation(send: AgentJournalSubmission, active: boolean) {
  const { queuedMessageId: _queue, keptAsQueuedMessageId: _kept, ...rest } = send
  return {
    ...rest,
    ...(!active && (_kept ?? _queue) ? { keptAsQueuedMessageId: _kept ?? _queue } : {}),
    ...(active && send.dispatchState === 'rejected' ? { resolvedAt: null } : {})
  }
}

export function sourceItem(
  journal: AgentSessionJournal,
  id: string
): AgentJournalRenderItem | null {
  const key = agentJournalSubmissionKey(id)
  const state = journal.queuedMessages.displayState()
  const source = state.inputs.sources.get(id)
  if (source?.kind === 'outcome-admission') {
    const handover = state.inputs.handovers.get(id)
    return (
      journal.item(key) ??
      (handover
        ? journalRenderItem(
            key,
            0,
            source.item.body,
            handover,
            AGENT_JOURNAL_THREAD_SCOPE,
            source.item
          )
        : source.item)
    )
  }
  return (
    journal.item(key) ??
    (source
      ? journalRenderItem(
          key,
          0,
          source.body,
          state.inputs.handovers.get(id) ?? source,
          AGENT_JOURNAL_THREAD_SCOPE,
          source
        )
      : null)
  )
}

const presentations = new WeakMap<
  AgentSessionJournal,
  { revision: number; cards: object; submissions: AgentJournalSubmission[] }
>()
export function queuedImageReaderSnapshot(
  journal: AgentSessionJournal,
  snapshot = journal.snapshot(),
  touched?: ReadonlySet<string>
) {
  return finishJournalSteps(queuedImageReaderSnapshotSteps(journal, snapshot, touched))
}

export function* queuedImageReaderSnapshotSteps(
  journal: AgentSessionJournal,
  snapshot: ReturnType<AgentSessionJournal['snapshot']>,
  touched?: ReadonlySet<string>
): Generator<void, typeof snapshot> {
  const cards = yield* readPublishedQueuedMessageSteps(journal)
  const { ids, imageIds } = yield* sourceIdSteps(journal, cards)
  if (imageIds.size === 0) {
    return snapshot
  }
  const revision = journal.queuedMessages.displayState().inputs.revision
  const present = (send: AgentJournalSubmission) =>
    ids.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
      ? sourcePresentation(send, ids.get(send.clientMessageId) === true)
      : send
  let memo = presentations.get(journal)
  if (!touched && (!memo || memo.revision !== revision || memo.cards !== cards)) {
    const submissions: AgentJournalSubmission[] = []
    for (const send of snapshot.submissions) {
      submissions.push(present(send))
      yield
    }
    memo = { revision, cards, submissions }
    presentations.set(journal, memo)
  }
  let items = snapshot.items
  if (touched) {
    items = []
    for (const id of touched) {
      const item = journal.item(id)
      if (item) {
        items.push(item)
      }
      yield
    }
  }
  const retained: AgentJournalRenderItem[] = []
  for (const [id, unchanged] of ids) {
    if (
      (!touched || touched.has(agentJournalSubmissionKey(id))) &&
      unchanged &&
      journal.submission(id)?.dispatchState !== 'accepted' &&
      !journal.item(agentJournalSubmissionKey(id))
    ) {
      const item = sourceItem(journal, id)
      if (item) {
        retained.push(item)
      }
    }
    yield
  }
  let submissions = memo?.submissions ?? []
  if (retained.length) {
    const selected = new Map<string, AgentJournalSubmission>()
    for (const send of touched ? snapshot.submissions : memo!.submissions) {
      selected.set(send.clientMessageId, touched ? present(send) : send)
      yield
    }
    for (const item of retained) {
      const original = journal.inputOrder.inputForItem(item.itemId)
      if (original) {
        selected.set(original.clientMessageId, present(original))
      }
      yield
    }
    submissions = yield* sortJournalSteps(
      selected.values(),
      (a, b) =>
        a.submittedAt - b.submittedAt ||
        journal.inputOrder.inputOrdinal(a.clientMessageId) -
          journal.inputOrder.inputOrdinal(b.clientMessageId)
    )
  } else if (touched) {
    submissions = []
    for (const send of snapshot.submissions) {
      submissions.push(present(send))
      yield
    }
  }
  return {
    ...snapshot,
    items: retained.length
      ? yield* sortJournalSteps(combinedItems(items, retained), compareAgentJournalItems)
      : items,
    submissions
  }
}

function* combinedItems(
  items: readonly AgentJournalRenderItem[],
  retained: readonly AgentJournalRenderItem[]
) {
  yield* items
  yield* retained
}

export function queuedImageSourceIds(journal: AgentSessionJournal, messageId: string): string[] {
  const row = journal.queuedMessages.displayState().queue.cards.get(messageId)
  return [
    messageId,
    ...(row?.recovers ? [row.recovers] : []),
    ...(row?.consumedAs ? [row.consumedAs] : [])
  ]
}
