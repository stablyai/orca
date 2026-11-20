import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  type HistoryReader
} from '../history/agent-session-history-page-bounds'
import { BOUNDED_FRAME_ROW_BYTES } from '../history/agent-session-bounded-frame-item'
import { jsonBytes } from '../history/json-string-shortening'

type BatchEvent = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
/** Host facts a row-carrying batch must restate, or the client clears them. */
export type SubscriberHostWork = Pick<BatchEvent, 'latestTurn' | 'working' | 'actionablePromptIds'>
/** A live row as built and as this subscriber was sent it, with the sent form's JSON size. */
export type SubscriberLiveRow = {
  source: AgentJournalRenderItem
  sent: AgentJournalRenderItem
  bytes: number
}

/** What the client holds for the host facts after this frame, by the reducer's restatement rule. */
export function rememberSubscriberHostWork(
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent
): void {
  if (event.type === 'snapshot' || event.type === 'reset') {
    const { latestTurn, working, actionablePromptIds } = event.page
    subscriber.hostWork = { latestTurn, working, actionablePromptIds }
    return
  }
  if (event.type !== 'batch') {
    return
  }
  const { items, removedItemIds, submissions } = event.batch
  const restates = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  const prior = subscriber.hostWork ?? {}
  const field = <K extends keyof SubscriberHostWork>(key: K): SubscriberHostWork[K] =>
    restates || event[key] !== undefined ? event[key] : prior[key]
  subscriber.hostWork = {
    latestTurn: field('latestTurn'),
    working: field('working'),
    actionablePromptIds: field('actionablePromptIds')
  }
}

function hostWorkFields(subscriber: Subscriber): Partial<SubscriberHostWork> {
  const work = subscriber.hostWork ?? {}
  return Object.fromEntries(Object.entries(work).filter(([, value]) => value !== undefined))
}

function bodyText(item: AgentJournalRenderItem): string | null {
  return item.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
    ? item.body.blocks[0].text
    : null
}

/** A shortened row whose visible text did not move is the row the subscriber already holds. */
function sameSentForm(row: SubscriberLiveRow | undefined, sent: AgentJournalRenderItem): boolean {
  return (
    row?.sent.shortened === true &&
    sent.shortened === true &&
    row.sent.revision === sent.revision &&
    bodyText(row.sent) === bodyText(sent)
  )
}

/** Record live rows a durable frame already carried, so the next live frame skips them. */
export function noteSubscriberLiveRow(subscriber: Subscriber) {
  return (source: AgentJournalRenderItem, sent: AgentJournalRenderItem, bytes: number): void => {
    ;(subscriber.liveSent ??= new Map()).set(source.itemId, { source, sent, bytes })
  }
}

/** Escapes that straddle the appended text's edge can shift its JSON size by a few bytes. */
const GROWTH_SIZE_SLACK_BYTES = 16

/** A live row sized from its previous form when only its text grew, so a long reply is not
 *  stringified or shortened again every window. */
function liveRow(
  prior: SubscriberLiveRow | undefined,
  source: AgentJournalRenderItem,
  form: HistoryReader['form'],
  maxBytes: number
): SubscriberLiveRow {
  const before = prior && prior.source.revision === source.revision ? bodyText(prior.source) : null
  const after = bodyText(source)
  if (prior && before !== null && after !== null && after.startsWith(before)) {
    // A shortened row shows its head, which more text cannot move.
    if (prior.sent.shortened) {
      return { ...prior, source }
    }
    const bytes = prior.bytes + jsonBytes(after.slice(before.length)) - jsonBytes('')
    if (prior.sent === prior.source && bytes + GROWTH_SIZE_SLACK_BYTES <= maxBytes) {
      return { source, sent: source, bytes }
    }
  }
  const formed = form(source)
  return { source, sent: formed.item, bytes: formed.bytes }
}

/** A durable frame takes newer live text for rows at the revision that text was placed on, so a
 *  save or a fresh view never shows less than the stream already did. */
export function withSubscriberLiveText(
  items: AgentJournalRenderItem[],
  readLive: () => readonly AgentJournalRenderItem[],
  form: HistoryReader['form'],
  applied?: (live: AgentJournalRenderItem, sent: AgentJournalRenderItem, bytes: number) => void
): AgentJournalRenderItem[] {
  const live = items.length > 0 ? readLive() : []
  if (live.length === 0) {
    return items
  }
  const newer = new Map(live.map((item) => [item.itemId, item]))
  let changed = false
  const next = items.map((item) => {
    const shown = newer.get(item.itemId)
    if (!shown || shown.revision !== item.revision) {
      return item
    }
    changed = true
    // The live row shares this revision's placement, and its object keeps one cached wire form.
    const { item: sent, bytes } = form(shown)
    applied?.(shown, sent, bytes)
    return sent
  })
  return changed ? next : items
}

/** A durable batch with newer live text; phones re-split batches, so they take it too. */
export function batchWithSubscriberLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  items: AgentJournalRenderItem[],
  reader: HistoryReader
): AgentJournalRenderItem[] {
  const live = () => port.hooks.readLiveText?.(subscriber.sessionId) ?? []
  return withSubscriberLiveText(items, live, reader.form, noteSubscriberLiveRow(subscriber))
}

/** A phone page is already sized to its frame and never re-split, so its live rows follow as a batch. */
export function pageWithSubscriberLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  items: AgentJournalRenderItem[],
  reader: HistoryReader
): AgentJournalRenderItem[] {
  const live = () => port.hooks.readLiveText?.(subscriber.sessionId) ?? []
  subscriber.liveSent = new Map()
  return subscriber.boundedFrames
    ? items
    : withSubscriberLiveText(items, live, reader.form, noteSubscriberLiveRow(subscriber))
}

/** Send a phone the live rows its replacement page left out. */
export function followPageWithLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number
): Promise<void> {
  return subscriber.boundedFrames
    ? publishSubscriberLiveText(port, {
        sessionId: subscriber.sessionId,
        journal,
        fence: subscriber.fence,
        items: port.hooks.readLiveText?.(subscriber.sessionId) ?? [],
        subscribers: [subscriber],
        hostNow
      })
    : Promise.resolve()
}

/** Ordinary equal-cursor items preserve the existing desktop and phone merge contract. */
export async function publishSubscriberLiveText(
  port: SubscriberDeliveryPort,
  input: {
    sessionId: string
    journal: AgentSessionJournal
    fence: number
    items: readonly AgentJournalRenderItem[]
    subscribers: readonly Subscriber[]
    hostNow: number
  }
): Promise<void> {
  const { sessionId, journal, fence, items, subscribers, hostNow } = input
  if (items.length === 0) {
    return
  }
  const cursor = journal.cursor()
  for (const subscriber of subscribers) {
    if (
      subscriber.cursor.epoch !== cursor.epoch ||
      subscriber.cursor.sequence !== cursor.sequence
    ) {
      continue
    }
    const sent = subscriber.liveSent
    // Live rows get the same per-row bounds a durable read gives this subscriber.
    const { form } = subscriberHistoryReader(subscriber)
    const maxBytes = subscriber.boundedFrames
      ? BOUNDED_FRAME_ROW_BYTES
      : HISTORY_PAGE_CONTENT_BUDGET_BYTES
    const rows: SubscriberLiveRow[] = []
    const fresh: AgentJournalRenderItem[] = []
    for (const source of items) {
      // Without the row's text to append to, it would go whole every window; its save carries it.
      if (subscriber.holdsTextBase?.(source.itemId) === false) {
        continue
      }
      const prior = sent?.get(source.itemId)
      // An unchanged row keeps its object, so a row this subscriber already has is not rebuilt.
      const row = prior?.source === source ? prior : liveRow(prior, source, form, maxBytes)
      rows.push(row)
      if (row !== prior && !sameSentForm(prior, row.sent)) {
        fresh.push(row.sent)
      }
    }
    subscriber.liveSent = new Map(rows.map((row) => [row.source.itemId, row]))
    if (fresh.length === 0) {
      continue
    }
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId,
        fence,
        hostNow,
        ...hostWorkFields(subscriber),
        batch: { ...emptyAgentSessionBatch(cursor), items: fresh }
      },
      { journal, queuePublication: { value: subscriber.queuePublication } }
    )
  }
}
