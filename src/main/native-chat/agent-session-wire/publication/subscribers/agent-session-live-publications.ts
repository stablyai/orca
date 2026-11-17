import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { backgroundTaskFingerprint } from './agent-session-subscriber-frame-fields'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import type { HistoryReader } from '../history/agent-session-history-page-bounds'

/** A durable frame takes newer live text for rows at the revision that text was placed on, so a
 *  save or a fresh view never shows less than the stream already did. */
export function withSubscriberLiveText(
  items: AgentJournalRenderItem[],
  readLive: () => readonly AgentJournalRenderItem[],
  form: HistoryReader['form'],
  applied?: (live: AgentJournalRenderItem) => void
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
    applied?.(shown)
    // The live row shares this revision's placement, and its object keeps one cached wire form.
    return form(shown).item
  })
  return changed ? next : items
}

/** A phone page is already sized to its frame and never re-split, so its live rows follow as a batch. */
export function pageWithSubscriberLiveText(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  items: AgentJournalRenderItem[],
  reader: HistoryReader
): AgentJournalRenderItem[] {
  const live = () => port.hooks.readLiveText?.(subscriber.sessionId) ?? []
  const sent = new Map<string, AgentJournalRenderItem>()
  subscriber.liveSent = sent
  return subscriber.boundedFrames
    ? items
    : withSubscriberLiveText(items, live, reader.form, (item) => sent.set(item.itemId, item))
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
    // Unchanged rows keep their object, so a row this subscriber already has is not resent.
    const sent = subscriber.liveSent
    const fresh = items.filter((item) => sent?.get(item.itemId) !== item)
    if (fresh.length === 0) {
      continue
    }
    // Live rows get the same per-row bounds a durable read gives this subscriber.
    const { form } = subscriberHistoryReader(subscriber)
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId,
        fence,
        hostNow,
        batch: { ...emptyAgentSessionBatch(cursor), items: fresh.map((item) => form(item).item) }
      },
      { journal, queuePublication: { value: subscriber.queuePublication } }
    )
    subscriber.liveSent = new Map(items.map((item) => [item.itemId, item]))
  }
}

export async function republishSubscriberBackgroundTasks(
  port: SubscriberDeliveryPort,
  subscribers: readonly Subscriber[],
  sessionId: string,
  fence: number,
  hostNow: number
): Promise<void> {
  const state = port.hooks.readBackgroundTasks?.(sessionId)
  if (state === undefined) {
    return
  }
  const fingerprint = backgroundTaskFingerprint(state)
  for (const subscriber of subscribers) {
    if (subscriber.backgroundTasks === fingerprint) {
      continue
    }
    await port.emit(subscriber, {
      type: 'batch',
      sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence,
      backgroundTasks: state,
      hostNow
    })
    subscriber.fence = fence
  }
}

export function createSubscriberLiveTextPublisher(
  port: () => SubscriberDeliveryPort,
  subscribers: (sessionId: string) => Subscriber[],
  now: () => number
) {
  return (
    sessionId: string,
    journal: AgentSessionJournal,
    fence: number,
    items: readonly AgentJournalRenderItem[],
    targets = subscribers(sessionId)
  ): Promise<void> =>
    publishSubscriberLiveText(port(), {
      sessionId,
      journal,
      fence,
      items,
      subscribers: targets,
      hostNow: now()
    })
}
