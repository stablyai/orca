import { jsonBytes } from '../history/json-string-shortening'
import { BOUNDED_FRAME_ROW_BYTES } from '../history/agent-session-bounded-frame-item'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../history/agent-session-history-page-bounds'
import { agentSessionTextAppendSource } from '../../../../../shared/agent-session/view/live-read/agent-session-text-append-source'
import { onlyStreamedTextChanged } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import type { HistoryReader } from '../history/agent-session-history-page-bounds'

type BatchEvent = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
/** Host facts a row-carrying batch must restate, or the client clears them. */
export type SubscriberHostWork = Pick<BatchEvent, 'latestTurn' | 'working' | 'actionablePromptIds'>
/** A live row as built and as this subscriber was sent it. */
export type SubscriberLiveRow = { source: AgentJournalRenderItem; sent: AgentJournalRenderItem }

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
  return (source: AgentJournalRenderItem, sent: AgentJournalRenderItem): void => {
    ;(subscriber.liveSent ??= new Map()).set(source.itemId, { source, sent })
  }
}

/** A durable frame takes newer live text for rows at the revision that text was placed on, so a
 *  save or a fresh view never shows less than the stream already did. */
export function withSubscriberLiveText(
  items: AgentJournalRenderItem[],
  readLive: () => readonly AgentJournalRenderItem[],
  form: HistoryReader['form'],
  applied?: (live: AgentJournalRenderItem, sent: AgentJournalRenderItem) => void
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
    const sent = form(shown).item
    applied?.(shown, sent)
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
    const rows: SubscriberLiveRow[] = []
    const fresh: AgentJournalRenderItem[] = []
    for (const source of items) {
      const prior = sent?.get(source.itemId)
      // An unchanged row keeps its object, so a row this subscriber already has is not rebuilt.
      const before = prior && agentSessionTextAppendSource(prior.source)
      const after = agentSessionTextAppendSource(source)
      const clippedUnchanged =
        prior?.sent.shortened &&
        before &&
        after &&
        before.identity === after.identity &&
        before.length <= after.length &&
        onlyStreamedTextChanged(prior.source, source)
      // A suffix must fit both the frame and the full row the next durable read will carry.
      const text =
        source.body.kind === 'message' && source.body.blocks[0]?.type === 'text'
          ? source.body.blocks[0]
          : null
      const fullBytes =
        after?.jsonBytes !== undefined && text
          ? jsonBytes({ ...source, body: { ...source.body, blocks: [{ ...text, text: '' }] } }) +
            after.jsonBytes
          : undefined
      const budget = subscriber.boundedFrames
        ? BOUNDED_FRAME_ROW_BYTES
        : HISTORY_PAGE_CONTENT_BUDGET_BYTES
      const fits = fullBytes !== undefined ? fullBytes <= budget : form(source).item === source
      const projected =
        prior?.source === source || clippedUnchanged
          ? prior.sent
          : fits
            ? (subscriber.projectLiveItem?.(source) ?? source)
            : source
      const fitted = prior?.sent === projected ? projected : form(projected).item
      // A clipped append cannot be decoded; send the ordinary bounded item instead.
      const wire = 'textAppend' in projected && fitted !== projected ? form(source).item : fitted
      const row = prior?.source === source ? prior : { source, sent: wire }
      rows.push(row)
      if (row !== prior && row.sent !== prior?.sent && !sameSentForm(prior, row.sent)) {
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
