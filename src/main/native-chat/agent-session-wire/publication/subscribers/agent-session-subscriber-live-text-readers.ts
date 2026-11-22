import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  LiveTextRead,
  LiveTextReaders
} from '../../journal-ingress/structured-agent-session-event-sink'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { isAppendOnlyLiveRow } from '../../journal-ingress/structured-agent-session-live-text-rows'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberLiveRow } from './agent-session-subscriber-live-text'

/** Replies a subscriber's last shortened rows were; one more than this is a reply long since saved. */
const SHORTENED_ROWS_KEPT = 16

/** A shortened reply row never grows on screen, so its live text needs no reading until its save.
 *  Other agents' timeline rows go whole each window, as before, so they are never held back. */
export function noteShortenedRow(subscriber: Subscriber, row: SubscriberLiveRow): void {
  if (row.sent.shortened !== true || !isAppendOnlyLiveRow(row.source)) {
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

// Asked every streaming window, but its answer changes only when a subscriber of that session
// joins, leaves, or says it is shown or hidden; each reader's own state is read through it lazily.
const sessionReaders = new WeakMap<ReadonlyMap<string, Subscriber>, LiveTextReaders | null>()

/** A subscriber joined or left this session, or one of its viewers said it is shown or hidden. */
export function noteLiveTextReadersChanged(
  subscribers: ReadonlyMap<string, Subscriber> | undefined
): void {
  if (subscribers) {
    sessionReaders.delete(subscribers)
  }
}

/** Who would read a session's live text; null while it has no subscriber. */
export function sessionLiveTextReaders(
  subscribers: ReadonlyMap<string, Subscriber> | undefined
): LiveTextReaders | null {
  if (!subscribers) {
    return null
  }
  const cached = sessionReaders.get(subscribers)
  if (cached !== undefined) {
    return cached
  }
  const readers = groupedLiveTextReaders([...subscribers.values()])
  sessionReaders.set(subscribers, readers)
  return readers
}

function groupedLiveTextReaders(all: readonly Subscriber[]): LiveTextReaders | null {
  // Read as the fan-out reads: shown viewers apart from the rest, each with its own interest.
  const groups = [true, false].flatMap((shown) => {
    const group = all.filter((subscriber) => shownViewer(subscriber) === shown)
    return group.length > 0 ? [liveTextReadersOf(group, shown)] : []
  })
  return groups.length > 0 ? { ...liveTextReadersOf(all, all.some(shownViewer)), groups } : null
}

/** A reader sent a reply's row whose append base is gone waits on its save, which restores it. */
const readerAwaitsBase = (reader: Subscriber, itemId: string): boolean =>
  reader.liveSent?.has(itemId) === true && reader.holdsTextBase?.(itemId) === false

/** Rows a live publication's frames carry, split so none passes `maxBytes`. */
export function framesWithin(rows: readonly SubscriberLiveRow[], maxBytes: number) {
  const frames: SubscriberLiveRow[][] = []
  let bytes = Infinity
  for (const row of rows) {
    if (bytes + row.bytes > maxBytes) {
      frames.push([])
      bytes = 0
    }
    frames.at(-1)!.push(row)
    bytes += row.bytes
  }
  return frames
}

/** What a reader holds after a publication: the rows it took, plus rows skipped for want of an
 *  append base, so those aren't sent whole again until their save restores the base. */
export function sentRowsAfter(
  subscriber: Subscriber,
  before: ReadonlyMap<string, SubscriberLiveRow> | undefined,
  rows: readonly SubscriberLiveRow[]
): Map<string, SubscriberLiveRow> {
  const next = new Map(rows.map((row) => [row.source.itemId, row]))
  before?.forEach((row, itemId) => {
    if (!next.has(itemId) && subscriber.holdsTextBase?.(itemId) === false) {
      next.set(itemId, row)
    }
  })
  return next
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
        takes: (itemId) => appenders.some((reader) => !reader.liveShortened?.has(itemId)),
        awaitsBase: (itemId) => appenders.every((reader) => readerAwaitsBase(reader, itemId))
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
      /** The session's subscribers, whose readers a shown or hidden viewer changes. */
      session: (sessionId: string) => ReadonlyMap<string, Subscriber> | undefined
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
      noteLiveTextReadersChanged(this.deps.session(subscriber.sessionId))
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

/** A row whose stream ended is saved whole, so what was last sent of it is let go. */
export function forgetEndedLiveRows(
  subscriber: Subscriber,
  live: readonly AgentJournalRenderItem[],
  within?: ReadonlySet<string> // a save's rows; outside one, a row awaiting its base is kept
) {
  const sent = subscriber.liveSent
  if (!sent || sent.size === 0) {
    return
  }
  const streaming = new Set(live.map((item) => item.itemId))
  for (const itemId of sent.keys()) {
    const waits = within === undefined && subscriber.holdsTextBase?.(itemId) === false
    if (!streaming.has(itemId) && within?.has(itemId) !== false && !waits) {
      sent.delete(itemId)
    }
  }
}
