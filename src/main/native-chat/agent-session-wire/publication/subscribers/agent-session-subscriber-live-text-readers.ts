import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  LiveTextRead,
  LiveTextReaders
} from '../../journal-ingress/structured-agent-session-event-sink'
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
  subscribers: readonly Subscriber[]
): readonly AgentJournalRenderItem[] {
  return typeof read === 'function' ? read(liveTextReadersOf(subscribers)) : read
}

/** Who would read a session's live text; null while nobody is subscribed. */
export function sessionLiveTextReaders(
  subscribers: ReadonlyMap<string, Subscriber> | undefined
): LiveTextReaders | null {
  const shown = [...(subscribers?.values() ?? [])].filter(viewerShown)
  return shown.length > 0 ? liveTextReadersOf(shown) : null
}

/** Whether a subscriber's window shows; a host that can't see it treats it as shown. */
export const viewerShown = (subscriber: Subscriber): boolean => subscriber.viewer?.hidden() !== true

/** Watches each subscriber's window, to send it what it skipped while hidden once it shows. */
export class ShownViewerWatches {
  private readonly watches = new WeakMap<Subscriber, () => void>()

  /** Watches a new subscriber's window, and stops watching the one it replaced. */
  watch(subscriber: Subscriber, replaced: Subscriber | undefined, shown: () => void): void {
    if (replaced) {
      this.unwatch(replaced)
    }
    const stop = subscriber.viewer?.subscribeShown(shown)
    if (stop) {
      this.watches.set(subscriber, stop)
    }
  }

  unwatch(subscriber: Subscriber): void {
    this.watches.get(subscriber)?.()
    this.watches.delete(subscriber)
  }
}

function liveTextReadersOf(subscribers: Iterable<Subscriber>): LiveTextReaders {
  const appenders = [...subscribers].filter((subscriber) => subscriber.holdsTextBase !== undefined)
  return appenders.length === 0
    ? { appends: false }
    : {
        appends: true,
        takes: (itemId) => appenders.some((reader) => !reader.liveShortened?.has(itemId))
      }
}
