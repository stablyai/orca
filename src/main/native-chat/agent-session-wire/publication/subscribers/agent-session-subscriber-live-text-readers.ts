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

const viewerShown = (subscriber: Subscriber): boolean => subscriber.viewer?.hidden() !== true

/** Live text goes only to viewers whose window shows; a hidden one gets the newest text once it
 *  shows, read again from the session's last publication. */
export class LiveTextForShownViewers {
  private readonly republish = new Map<string, (targets: readonly Subscriber[]) => void>()
  private readonly watches = new WeakMap<Subscriber, () => void>()

  shown(
    sessionId: string,
    targets: readonly Subscriber[],
    republish: (targets: readonly Subscriber[]) => void
  ): readonly Subscriber[] {
    this.republish.set(sessionId, republish)
    return targets.filter(viewerShown)
  }

  /** Watches a new subscriber's window, and stops watching the one it replaced. */
  watch(subscriber: Subscriber, replaced?: Subscriber): void {
    if (replaced) {
      this.unwatch(replaced, false)
    }
    const stop = subscriber.viewer?.subscribeShown(() =>
      this.republish.get(subscriber.sessionId)?.([subscriber])
    )
    if (stop) {
      this.watches.set(subscriber, stop)
    }
  }

  unwatch(subscriber: Subscriber, sessionEnded: boolean): void {
    this.watches.get(subscriber)?.()
    this.watches.delete(subscriber)
    if (sessionEnded) {
      this.republish.delete(subscriber.sessionId)
    }
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
