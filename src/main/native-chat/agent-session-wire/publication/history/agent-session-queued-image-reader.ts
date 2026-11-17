import type {
  AgentJournalSubmission,
  AgentJournalSnapshot
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../../../shared/agent-session/journal/agent-session-journal-position'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { QueuedMessageRow } from '../../../agent-session-journal/queued-messages/queued-message-table'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from '../../observations/agent-session-published-work'
import { boundedFrameItem } from './agent-session-bounded-frame-item'
import { agentJournalItemForWire } from './agent-session-item-wire-form'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import { SubscriberFrameSuperseded } from '../subscribers/agent-session-subscriber-frame-capture'

export const queuedCardHoldsImage = (card: Pick<AgentSessionQueuedMessage, 'body'>): boolean =>
  card.body.blocks.some((block) => block.type === 'image-ref')

// Publication arrays are immutable; retain their derived source relation for the sent baseline.
const relations = new WeakMap<
  object,
  {
    ids: ReadonlyMap<string, boolean>
    imageIds: ReadonlySet<string>
    fingerprints: ReadonlyMap<string, string>
  }
>()
async function sourceIds(
  journal: AgentSessionJournal,
  cards: readonly Pick<AgentSessionQueuedMessage, 'body' | 'messageId'>[],
  queueRows?: readonly QueuedMessageRow[]
) {
  const cached = relations.get(cards)
  if (cached) {
    return cached
  }
  const ids = new Map<string, boolean>()
  const imageIds = new Set<string>()
  const fingerprints = new Map<string, string>()
  const imageCards = cards.filter(queuedCardHoldsImage)
  const rows = new Map(
    (imageCards.length ? (queueRows ?? (await journal.queuedMessages.list())) : []).map((row) => [
      row.messageId,
      row
    ])
  )
  const sourceKeys = imageCards.flatMap((card) => {
    const row = rows.get(card.messageId)
    return row && (row.state === 'waiting' || row.state === 'returned')
      ? [row.recovers ?? row.consumedAs ?? card.messageId]
      : []
  })
  const inputs = await queuedImageInputs(journal, sourceKeys)
  for (const card of imageCards) {
    const row = rows.get(card.messageId)
    if (row?.state !== 'waiting' && row?.state !== 'returned') {
      continue
    }
    imageIds.add(card.messageId)
    const id = row.recovers ?? row.consumedAs ?? card.messageId
    const send = inputs.get(id)?.submission
    fingerprints.set(id, row.fingerprint)
    if (!send) {
      ids.set(id, true)
    }
    if (
      send &&
      (row.recovers === id ||
        row.consumedAs === id ||
        send.keptAsQueuedMessageId === card.messageId)
    ) {
      ids.set(id, send.payloadFingerprint === row.fingerprint)
    }
  }
  const result = { ids, imageIds, fingerprints }
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

async function queuedImageInputs(journal: AgentSessionJournal, ids: readonly string[]) {
  const inputs = new Map<string, { submission: AgentJournalSubmission | undefined }>()
  for (let start = 0; start < ids.length; start += 128) {
    const reached = ids.slice(start, start + 128)
    const { results } = await journal.reads.input({
      kind: 'batch',
      reads: reached.map((id) => ({
        kind: 'input-for-item' as const,
        itemId: agentJournalSubmissionKey(id)
      }))
    })
    reached.forEach((id, index) => {
      const send = results[index]
      inputs.set(id, {
        submission: 'submission' in send ? send.submission : undefined
      })
    })
  }
  return inputs
}

export function queuedImageReaderSnapshot(
  journal: AgentSessionJournal,
  snapshot?: AgentJournalSnapshot,
  _touched?: ReadonlySet<string>
): AgentJournalSnapshot {
  // SQL has already selected membership and presented submissions within the ordered read.
  return (
    snapshot ?? {
      sessionId: journal.identity.sessionId,
      cursor: journal.cursor(),
      items: [],
      submissions: []
    }
  )
}

export type QueuedImageHistoryPolicy = {
  ids: readonly (readonly [string, boolean])[]
  imageIds: readonly string[]
  links?: readonly (readonly [string, readonly string[]])[]
}

/** Held read: its caller owns the chat lane through history materialization and presentation. */
export async function heldQueuedImageHistoryPolicy(
  journal: AgentSessionJournal
): Promise<QueuedImageHistoryPolicy> {
  const rows = await journal.queuedMessages.list()
  const cards = rows.filter((row) => row.state === 'waiting' || row.state === 'returned')
  const { ids, imageIds } = await sourceIds(journal, cards, rows)
  return {
    ids: [...ids],
    imageIds: [...imageIds],
    links: cards.map((row) => [
      row.messageId,
      [
        row.messageId,
        ...new Set(
          [row.recovers, row.consumedAs].filter((id): id is string => typeof id === 'string')
        )
      ]
    ])
  }
}

export const unchangedQueuedImageSubmission = (
  send: AgentJournalSubmission
): AgentJournalSubmission => send

export function queuedImageSubmissionPresenter(policy: QueuedImageHistoryPolicy) {
  if (policy.ids.length === 0 && policy.imageIds.length === 0) {
    return unchangedQueuedImageSubmission
  }
  const ids = new Map(policy.ids)
  const imageIds = new Set(policy.imageIds)
  return (send: AgentJournalSubmission): AgentJournalSubmission =>
    ids.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
      ? sourcePresentation(send, ids.get(send.clientMessageId) === true)
      : send
}

/** Only queue/source semantic changes correct rows; work and pause never replay the population. */
export async function queuedImageReaderEvent(
  journal: AgentSessionJournal,
  event: AgentSessionSubscribeEvent,
  previous: QueuePublication | undefined,
  current: QueuePublication | undefined,
  work?: AgentSessionPublishedWork
): Promise<AgentSessionSubscribeEvent> {
  if (
    !current ||
    (event.type === 'batch' &&
      previous?.queuedMessages === current.queuedMessages &&
      event.batch.submissions.length === 0)
  ) {
    return event
  }
  return journal.readInOrder(async () => {
    // Current rows and cards are read here, so they must still be the frame's own.
    if (event.type === 'batch' && !sameJournalCursor(journal.cursor(), event.batch.cursor)) {
      throw new SubscriberFrameSuperseded()
    }
    const { ids: now, imageIds, fingerprints } = await sourceIds(journal, current.queuedMessages)
    if (event.type !== 'batch') {
      return event
    }
    const prior = await sourceIds(journal, previous?.queuedMessages ?? [])
    const before = prior.ids
    if (
      before === now &&
      !event.batch.submissions.some(
        (send) => now.has(send.clientMessageId) || imageIds.has(send.queuedMessageId ?? '')
      )
    ) {
      return event
    }
    const changed = new Set(
      [...before.keys(), ...now.keys()].filter(
        (id) =>
          before.get(id) !== now.get(id) || prior.fingerprints.get(id) !== fingerprints.get(id)
      )
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
    const inputs = await queuedImageInputs(journal, [...changed])
    const saved = new Set(
      await journal.reads.savedItemIds([...changed].map(agentJournalSubmissionKey))
    )
    const sources = new Map(
      (
        await journal.reads.historySourceItems(
          [...changed].filter(
            (id) => now.get(id) === true && !saved.has(agentJournalSubmissionKey(id))
          )
        )
      ).map((item) => [item.itemId, item])
    )
    for (const id of changed) {
      const key = agentJournalSubmissionKey(id)
      const original = submissions.get(id) ?? inputs.get(id)?.submission
      const send = original && work ? work.publishedSubmission(original) : original
      const active = now.get(id) === true && send?.dispatchState !== 'accepted'
      if (
        !saved.has(key) &&
        ((before.get(id) === true) !== active ||
          prior.fingerprints.get(id) !== fingerprints.get(id))
      ) {
        const item = active ? sources.get(key) : null
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
  })
}

export async function queuedImageSourceIds(
  journal: AgentSessionJournal,
  messageId: string
): Promise<string[]> {
  const row = await journal.queuedMessages.get(messageId)
  return [
    messageId,
    ...(row?.recovers ? [row.recovers] : []),
    ...(row?.consumedAs ? [row.consumedAs] : [])
  ]
}
