import { sessionCrewChanges } from '../../../../runtime/orchestration/crew/crew-changes'
import { FORK_MARKER_ITEM_ID } from '../history/agent-session-fork-marker'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'

export function watchForkSourceNames(refresh: (sources?: readonly string[]) => void): () => void {
  return sessionCrewChanges.subscribe((change) => {
    if (change.has('names') || change.has('records')) {
      refresh(change.recordIds)
    }
  })
}

export class ForkMarkerSubscriptions {
  private stopWatching: (() => void) | undefined
  private readonly childrenBySource = new Map<string, Set<string>>()
  constructor(
    private readonly port: () => SubscriberDeliveryPort,
    private readonly subscribers: (id: string) => Subscriber[],
    private readonly now: () => number,
    private readonly readJournal: (id: string) => AgentSessionJournal | undefined
  ) {}

  add(subscriber: Subscriber): void {
    const source = subscriber.readForkMarker?.()?.forkedFrom.sessionId
    if (!source) {
      return
    }
    const children = this.childrenBySource.get(source) ?? new Set<string>()
    children.add(subscriber.sessionId)
    this.childrenBySource.set(source, children)
    this.stopWatching ??= watchForkSourceNames((sources) =>
      this.refreshSources(this.readJournal, sources)
    )
  }

  delete(subscriber: Subscriber): void {
    // A deleted child no longer has a readable record, so release by its retained identity.
    for (const [source, children] of this.childrenBySource) {
      children.delete(subscriber.sessionId)
      if (!children.size) {
        this.childrenBySource.delete(source)
      }
    }
    if (!this.childrenBySource.size) {
      this.stopWatching?.()
      this.stopWatching = undefined
    }
  }

  refreshSources(
    readJournal: (sessionId: string) => AgentSessionJournal | undefined,
    sourceIds?: readonly string[]
  ): void {
    for (const source of sourceIds ?? this.childrenBySource.keys()) {
      for (const child of this.childrenBySource.get(source) ?? []) {
        const journal = readJournal(child)
        if (journal) {
          for (const subscriber of this.subscribers(child)) {
            this.refresh(subscriber, journal)
          }
        }
      }
    }
  }

  refresh(subscriber: Subscriber, journal: AgentSessionJournal, force = false): void {
    const marker = subscriber.readForkMarker?.()
    const view = JSON.stringify(marker)
    if (!force && subscriber.forkMarkerView === view) {
      return
    }
    subscriber.forkMarkerView = view
    const reader = subscriberHistoryReader(subscriber)
    if (!marker) {
      return
    }
    const snapshot = reader.snapshot?.(journal, undefined, new Set([FORK_MARKER_ITEM_ID]))
    const items = snapshot?.items.map((item) => reader.form(item).item) ?? []
    const removedItemIds = items.some((item) => item.itemId === FORK_MARKER_ITEM_ID)
      ? []
      : [FORK_MARKER_ITEM_ID]
    this.port().emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), items, removedItemIds },
        fence: subscriber.fence,
        hostNow: this.now()
      },
      { journal }
    )
  }
}
