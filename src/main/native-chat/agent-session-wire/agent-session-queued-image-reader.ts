import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalRenderItem } from '../agent-session-journal/journal-render-item'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import {
  readPublishedQueuedMessages,
  type QueuePublication
} from './structured-agent-session-queued-publication'

export const queuedCardHoldsImage = (card: Pick<AgentSessionQueuedMessage, 'body'>): boolean =>
  card.body.blocks.some((block) => block.type === 'image-ref')

// Publication arrays are immutable; retain their derived source relation for the sent baseline.
const relations = new WeakMap<
  object,
  { ids: ReadonlyMap<string, boolean>; imageIds: ReadonlySet<string> }
>()
function sourceIds(
  journal: AgentSessionJournal,
  cards: readonly Pick<AgentSessionQueuedMessage, 'body' | 'messageId'>[]
) {
  const cached = relations.get(cards)
  if (cached) {
    return cached
  }
  const rows = new Map(journal.queuedMessages.list().map((card) => [card.messageId, card]))
  const ids = new Map<string, boolean>()
  const imageIds = new Set<string>()
  for (const card of cards) {
    if (!queuedCardHoldsImage(card)) {
      continue
    }
    const row = rows.get(card.messageId)
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

function sourcePresentation(send: AgentJournalSubmission, active: boolean) {
  const { queuedMessageId: _queue, keptAsQueuedMessageId: _kept, ...rest } = send
  return {
    ...rest,
    ...(!active && (_kept ?? _queue) ? { keptAsQueuedMessageId: _kept ?? _queue } : {}),
    ...(active && send.dispatchState === 'rejected' ? { resolvedAt: null } : {})
  }
}

function sourceItem(journal: AgentSessionJournal, id: string): AgentJournalRenderItem | null {
  const key = agentJournalSubmissionKey(id)
  const state = journal.queuedMessages.displayState()
  const source = state.inputs.sources.get(id)
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
  const cards = readPublishedQueuedMessages(journal)
  const { ids, imageIds } = sourceIds(journal, cards)
  if (imageIds.size === 0) {
    return snapshot
  }
  const revision = journal.queuedMessages.displayState().inputs.revision
  let memo = presentations.get(journal)
  if (!memo || memo.revision !== revision || memo.cards !== cards) {
    const submissions = snapshot.submissions.map((send) =>
      ids.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
        ? sourcePresentation(send, ids.get(send.clientMessageId) === true)
        : send
    )
    memo = { revision, cards, submissions }
    presentations.set(journal, memo)
  }
  const items = touched ? [...touched].flatMap((id) => journal.item(id) ?? []) : snapshot.items
  const retained = [...ids].flatMap(([id, unchanged]) =>
    (touched && !touched.has(agentJournalSubmissionKey(id))) ||
    !unchanged ||
    journal.submission(id)?.dispatchState === 'accepted' ||
    journal.item(agentJournalSubmissionKey(id))
      ? []
      : (sourceItem(journal, id) ?? [])
  )
  return {
    ...snapshot,
    items: retained.length ? [...items, ...retained].sort(compareAgentJournalItems) : items,
    submissions: memo.submissions
  }
}

/** Only queue/source semantic changes correct rows; work and pause never replay the population. */
export function queuedImageReaderEvent(
  journal: AgentSessionJournal,
  event: AgentSessionSubscribeEvent,
  previous: QueuePublication | undefined,
  current: QueuePublication | undefined,
  work?: AgentSessionPublishedWork
): AgentSessionSubscribeEvent {
  if (!current || event.type !== 'batch') {
    return event
  }
  const { ids: now, imageIds } = sourceIds(journal, current.queuedMessages)
  const before = sourceIds(journal, previous?.queuedMessages ?? []).ids
  if (
    before === now &&
    !event.batch.submissions.some(
      (send) => now.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
    )
  ) {
    return event
  }
  const changed = new Set(
    [...before.keys(), ...now.keys()].filter((id) => before.get(id) !== now.get(id))
  )
  for (const send of event.batch.submissions) {
    if (
      now.has(send.clientMessageId) ||
      before.has(send.clientMessageId) ||
      imageIds.has(send.queuedMessageId ?? '')
    ) {
      changed.add(send.clientMessageId)
    }
  }
  if (changed.size === 0) {
    return event
  }
  const items = new Map(event.batch.items.map((item) => [item.itemId, item]))
  const removed = new Set(event.batch.removedItemIds)
  const submissions = new Map(event.batch.submissions.map((send) => [send.clientMessageId, send]))
  for (const id of changed) {
    const key = agentJournalSubmissionKey(id)
    const original = submissions.get(id) ?? journal.submission(id)
    const send = original && work ? work.publishedSubmission(original) : original
    const active = now.get(id) === true && send?.dispatchState !== 'accepted'
    if (!journal.item(key) && (before.get(id) === true) !== active) {
      const item = active ? sourceItem(journal, id) : null
      if (item) {
        items.set(key, boundedFrameItem(agentJournalItemForWire(item)).item)
        removed.delete(key)
      } else {
        items.delete(key)
        removed.add(key)
      }
    }
    if (send) {
      submissions.set(
        id,
        now.has(id) || imageIds.has(send.queuedMessageId ?? '')
          ? sourcePresentation(send, now.get(id) === true)
          : send
      )
    }
  }
  return {
    ...event,
    ...(work ? agentSessionPublishedWorkFields(journal, work) : {}),
    batch: {
      ...event.batch,
      items: [...items.values()].sort(compareAgentJournalItems),
      removedItemIds: [...removed],
      submissions: [...submissions.values()]
    }
  }
}

export function queuedImageSourceIds(journal: AgentSessionJournal, messageId: string): string[] {
  const row = journal.queuedMessages.displayState().queue.cards.get(messageId)
  return [
    messageId,
    ...(row?.recovers ? [row.recovers] : []),
    ...(row?.consumedAs ? [row.consumedAs] : [])
  ]
}
