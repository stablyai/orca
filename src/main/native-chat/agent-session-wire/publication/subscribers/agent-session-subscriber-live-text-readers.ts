import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  LiveTextRead,
  LiveTextReaders
} from '../../journal-ingress/structured-agent-session-event-sink'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberLiveRow } from './agent-session-subscriber-live-text'

/** Replies a subscriber's last shortened rows were; one more than this is a reply long since saved. */
const SHORTENED_ROWS_KEPT = 16

/** A shortened row never grows on screen, so its live text needs no reading until its save. */
export function noteShortenedRow(subscriber: Subscriber, row: SubscriberLiveRow): void {
  if (row.sent.shortened !== true) {
    return
  }
  const shortened = (subscriber.liveShortened ??= new Set())
  shortened.delete(row.source.itemId)
  shortened.add(row.source.itemId)
  if (shortened.size > SHORTENED_ROWS_KEPT) {
    shortened.delete(shortened.values().next().value!)
  }
}

export type SubscriberLiveTextSource = readonly AgentJournalRenderItem[] | LiveTextRead

/** One snapshot per fan-out, shared by every subscriber; rows only an append reader takes are not
 *  built when none of them is one. */
export function liveTextFor(
  read: SubscriberLiveTextSource,
  subscribers: readonly Subscriber[],
  shown: boolean
): readonly AgentJournalRenderItem[] {
  return typeof read === 'function' ? read(liveTextReadersOf(subscribers, shown)) : read
}

/** A viewer that opted in and says it is shown. Only it gets a Claude or Codex reply's newest
 *  text; every other subscriber, older phones and desktops included, gets what main sent it. */
export const shownViewer = (subscriber: Subscriber): boolean => subscriber.liveTextShown === true

/** Who would read a session's live text; null while it has no subscriber. */
export function sessionLiveTextReaders(
  subscribers: ReadonlyMap<string, Subscriber> | undefined
): LiveTextReaders | null {
  // Read as the fan-out reads: shown viewers apart from the rest, each with its own interest.
  const all = [...(subscribers?.values() ?? [])]
  const groups = [true, false].flatMap((shown) => {
    const group = all.filter((subscriber) => shownViewer(subscriber) === shown)
    return group.length > 0 ? [liveTextReadersOf(group, shown)] : []
  })
  return groups.length > 0 ? { ...liveTextReadersOf(all, all.some(shownViewer)), groups } : null
}

/** What one subscriber reads of the session's live text. */
export const subscriberLiveTextReaders = (subscriber: Subscriber): LiveTextReaders =>
  liveTextReadersOf([subscriber], shownViewer(subscriber))

function liveTextReadersOf(subscribers: Iterable<Subscriber>, shown: boolean): LiveTextReaders {
  const all = [...subscribers]
  const appenders = all.filter((subscriber) => subscriber.holdsTextBase !== undefined)
  if (appenders.length === 0) {
    return { appends: false, shown }
  }
  // A reader that takes whole rows takes every row, so none can be skipped for it.
  return appenders.length < all.length
    ? { appends: true, shown }
    : {
        appends: true,
        shown,
        takes: (itemId) => appenders.some((reader) => !reader.liveShortened?.has(itemId))
      }
}

/** Live text goes only to a subscriber that has every journal row; one behind waits for catch-up. */
export function subscriberAtHead(subscriber: Subscriber, journal: AgentSessionJournal): boolean {
  const cursor = journal.cursor()
  return subscriber.cursor.epoch === cursor.epoch && subscriber.cursor.sequence === cursor.sequence
}

/** Tries a shown viewer's catch-up waits behind before it is sent its newest text. */
const SHOWN_TAIL_ATTEMPTS = 3

/** Viewers saying they are shown or hidden. A viewer that becomes shown is sent the newest live
 *  text once, in its own delivery order, after any catch-up already queued ahead of it. */
export class LiveTextViewerShows {
  constructor(
    private readonly deps: {
      isActive: (subscriber: Subscriber) => boolean
      enqueue: (subscriber: Subscriber, deliver: () => Promise<unknown>) => void
      journal: (sessionId: string) => AgentSessionJournal | undefined
      sendTail: (subscriber: Subscriber, journal: AgentSessionJournal) => Promise<unknown>
    }
  ) {}

  /** Takes the viewer's word for the stream it opened, while the stream lasts. */
  watch(subscriber: Subscriber, onShown: ((set: (shown: boolean) => void) => void) | undefined) {
    onShown?.((shown) => this.set(subscriber, shown))
  }

  private set(subscriber: Subscriber, shown: boolean): void {
    if (subscriber.liveTextViewer === undefined || !this.deps.isActive(subscriber)) {
      return
    }
    if (subscriber.liveTextShown !== shown) {
      subscriber.liveTextShown = shown
      if (shown) {
        this.sendTail(subscriber, SHOWN_TAIL_ATTEMPTS)
      }
    }
  }

  private sendTail(subscriber: Subscriber, attempts: number): void {
    this.deps.enqueue(subscriber, async () => {
      const journal = this.deps.journal(subscriber.sessionId)
      if (!journal || !shownViewer(subscriber) || !this.deps.isActive(subscriber)) {
        return
      }
      // Behind a save, the catch-up already queued for it runs first, then this tries again.
      if (!subscriberAtHead(subscriber, journal) && attempts > 1) {
        this.sendTail(subscriber, attempts - 1)
        return
      }
      await this.deps.sendTail(subscriber, journal)
    })
  }
}
