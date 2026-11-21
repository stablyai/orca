import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { textExtends } from '../../../../../shared/agent-session/view/live-read/agent-session-text-append'
import { isAppendOnlyLiveRow } from '../../journal-ingress/structured-agent-session-live-text-rows'
import { noteShortenedRow } from './agent-session-subscriber-live-text-readers'
export {
  liveTextFor,
  LiveTextForShownViewers,
  sessionLiveTextReaders,
  type SubscriberLiveTextSource
} from './agent-session-subscriber-live-text-readers'
import {
  markBoundedBatchFits,
  subscriberHistoryReader
} from '../history/agent-session-bounded-frames'
import {
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
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
    const row = { source, sent, bytes }
    ;(subscriber.liveSent ??= new Map()).set(source.itemId, row)
    noteShortenedRow(subscriber, row)
  }
}

/** The batch's own JSON around its rows: cursor, keys and separators. */
const FRAME_SIZE_SLACK_BYTES = 4 * 1024

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
  // A snapshot read before a durable frame that already carried newer text must not undo it.
  const stale = before !== null && after !== null && before.length > after.length
  if (prior && stale && before.startsWith(after)) {
    return prior
  }
  if (prior && before !== null && after !== null && textExtends(source, after, before)) {
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
  applied?: (live: AgentJournalRenderItem, sent: AgentJournalRenderItem, bytes: number) => void,
  /** The rest of the page (its submissions and removals), which shares the page's budget. */
  besides: unknown = null
): AgentJournalRenderItem[] {
  const live = items.length > 0 ? readLive() : []
  if (live.length === 0) {
    return items
  }
  const newer = new Map(live.map((item) => [item.itemId, item]))
  let changed = false
  // The page stays within its own budget: the reply's other half belongs to the queue and lists.
  let room: number | undefined
  const next = items.map((item) => {
    const shown = newer.get(item.itemId)
    if (!shown || shown.revision !== item.revision) {
      return item
    }
    // The live row shares this revision's placement, and its object keeps one cached wire form.
    const { item: sent, bytes } = form(shown)
    room ??= HISTORY_PAGE_CONTENT_BUDGET_BYTES - jsonBytes(items) - jsonBytes(besides)
    const grown = bytes - jsonBytes(item)
    if (grown > room) {
      return item
    }
    room -= grown
    changed = true
    applied?.(shown, sent, bytes)
    return sent
  })
  return changed ? next : items
}

/** A durable page's rows and what shares their budget. */
type SizedPage = {
  items: AgentJournalRenderItem[]
  submissions?: readonly unknown[]
  removedItemIds?: readonly string[]
}

/** A durable batch with newer live text; phones re-split batches, so they take it too. */
export function batchWithSubscriberLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  page: SizedPage,
  reader: HistoryReader
): AgentJournalRenderItem[] {
  const live = (): readonly AgentJournalRenderItem[] => {
    const rows = port.hooks.readLiveText?.(subscriber.sessionId) ?? []
    forgetEndedLiveRows(subscriber, rows)
    return rows
  }
  return withSubscriberLiveText(page.items, live, reader.form, noteSubscriberLiveRow(subscriber), [
    page.submissions,
    page.removedItemIds
  ])
}

/** A row whose stream ended is saved whole, so what was last sent of it is let go. */
function forgetEndedLiveRows(subscriber: Subscriber, live: readonly AgentJournalRenderItem[]) {
  const sent = subscriber.liveSent
  if (!sent || sent.size === 0) {
    return
  }
  const streaming = new Set(live.map((item) => item.itemId))
  for (const itemId of sent.keys()) {
    if (!streaming.has(itemId)) {
      sent.delete(itemId)
    }
  }
}

/** A phone page is already sized to its frame and never re-split, so its live rows follow as a batch. */
export function pageWithSubscriberLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  page: SizedPage,
  reader: HistoryReader
): AgentJournalRenderItem[] {
  const live = () => port.hooks.readLiveText?.(subscriber.sessionId) ?? []
  subscriber.liveSent = new Map()
  subscriber.liveShortened = undefined
  return subscriber.boundedFrames
    ? page.items
    : withSubscriberLiveText(page.items, live, reader.form, noteSubscriberLiveRow(subscriber), [
        page.submissions,
        page.removedItemIds
      ])
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

/** A phone's live rows were each sized as formed; together within its frame, the frame skips
 *  measuring them again every window. */
function fitsBoundedFrame(subscriber: Subscriber, rowBytes: number): boolean {
  return (
    subscriber.boundedFrames &&
    rowBytes + FRAME_SIZE_SLACK_BYTES <= BOUNDED_FRAME_CONTENT_BUDGET_BYTES
  )
}

/** Live text goes only to a subscriber that has every journal row; one behind waits for catch-up. */
export function subscriberAtHead(subscriber: Subscriber, journal: AgentSessionJournal): boolean {
  const cursor = journal.cursor()
  return subscriber.cursor.epoch === cursor.epoch && subscriber.cursor.sequence === cursor.sequence
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
    subscribers.forEach((subscriber) => forgetEndedLiveRows(subscriber, items))
    return
  }
  const cursor = journal.cursor()
  for (const subscriber of subscribers) {
    if (!subscriberAtHead(subscriber, journal)) {
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
    let freshBytes = 0
    for (const source of items) {
      if (!subscriber.holdsTextBase && isAppendOnlyLiveRow(source)) {
        continue
      }
      // A shortened row never grows on screen, so its save carries it.
      if (subscriber.liveShortened?.has(source.itemId)) {
        continue
      }
      const prior = sent?.get(source.itemId)
      // Sent whole once, the row becomes the reader's base; one the reader still can't append to
      // would go whole every window, so its save carries it.
      if (prior && subscriber.holdsTextBase?.(source.itemId) === false) {
        noteShortenedRow(subscriber, prior)
        rows.push(prior)
        continue
      }
      // An unchanged row keeps its object, so a row this subscriber already has is not rebuilt.
      const row = prior?.source === source ? prior : liveRow(prior, source, form, maxBytes)
      rows.push(row)
      noteShortenedRow(subscriber, row)
      if (row !== prior && !sameSentForm(prior, row.sent)) {
        fresh.push(row.sent)
        freshBytes += row.bytes
      }
    }
    subscriber.liveSent = new Map(rows.map((row) => [row.source.itemId, row]))
    if (fresh.length === 0) {
      continue
    }
    const batch = { ...emptyAgentSessionBatch(cursor), items: fresh }
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId,
        fence,
        hostNow,
        ...hostWorkFields(subscriber),
        batch: fitsBoundedFrame(subscriber, freshBytes) ? markBoundedBatchFits(batch) : batch
      },
      { journal, queuePublication: { value: subscriber.queuePublication } }
    )
  }
}
