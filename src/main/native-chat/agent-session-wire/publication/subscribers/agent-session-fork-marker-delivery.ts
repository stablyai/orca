import { sessionCrewChanges } from '../../../../runtime/orchestration/crew/crew-changes'
import { FORK_MARKER_ITEM_ID } from '../history/agent-session-fork-marker'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
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
  /** A watched source's own source: renaming it can change how that source is shown. */
  private readonly parentBySource = new Map<string, string>()
  constructor(
    private readonly port: () => SubscriberDeliveryPort,
    private readonly subscribers: (id: string) => Subscriber[],
    private readonly now: () => number,
    private readonly readJournal: (id: string) => AgentSessionJournal | undefined,
    private readonly refreshSubscriber: (
      subscriber: Subscriber,
      journal: AgentSessionJournal
    ) => void
  ) {}

  add(subscriber: Subscriber): void {
    const marker = subscriber.readForkMarker?.()
    const source = marker?.forkedFrom.sessionId
    if (!source) {
      return
    }
    if (marker.sourceParentId) {
      this.parentBySource.set(source, marker.sourceParentId)
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
        this.parentBySource.delete(source)
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
    for (const source of this.affectedSources(sourceIds)) {
      for (const child of this.childrenBySource.get(source) ?? []) {
        const journal = readJournal(child)
        if (journal) {
          for (const subscriber of this.subscribers(child)) {
            this.refreshSubscriber(subscriber, journal)
          }
        }
      }
    }
  }

  private affectedSources(changed: readonly string[] | undefined): Iterable<string> {
    if (!changed) {
      return this.childrenBySource.keys()
    }
    const ids = new Set(changed)
    const sources = new Set(changed)
    for (const [source, parent] of this.parentBySource) {
      if (ids.has(parent)) {
        sources.add(source)
      }
    }
    return sources
  }

  async refresh(
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    force = false
  ): Promise<void> {
    const marker = subscriber.readForkMarker?.()
    // A source that was unreadable when watching began names its own source only now.
    if (marker?.sourceParentId && this.childrenBySource.has(marker.forkedFrom.sessionId)) {
      this.parentBySource.set(marker.forkedFrom.sessionId, marker.sourceParentId)
    }
    const view = JSON.stringify(marker)
    if (!force && subscriber.forkMarkerView === view) {
      return
    }
    subscriber.forkMarkerView = view
    const reader = subscriberHistoryReader(subscriber)
    if (!marker) {
      return
    }
    const snapshot = await reader.snapshot?.(journal, undefined, new Set([FORK_MARKER_ITEM_ID]))
    const items = snapshot?.items.map((item) => reader.form(item).item) ?? []
    const removedItemIds = items.some((item) => item.itemId === FORK_MARKER_ITEM_ID)
      ? []
      : [FORK_MARKER_ITEM_ID]
    if (!this.port().isActive(subscriber)) {
      return
    }
    await this.port().emit(
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
