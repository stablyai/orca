import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import {
  SubscriberLiveTextCapReached,
  CHAT_LIVE_TEXT_SUBSCRIBER_BYTES,
  heldBytesOf,
  noteLiveTextCapReached
} from '../../../retention/subscriber-live-text-cap'

/** Reads every row after the subscriber's cursor when it runs, so a later one covers an earlier one. */
export type SubscriberCatchUp = {
  journal: AgentSessionJournal
  port: SubscriberDeliveryPort
  /** The same fan-out's port with a queue read, shared by every subscriber that still owes one. */
  queuePort: () => SubscriberDeliveryPort
  queueChanged: boolean
  hostNow: number
  activity?: AgentSessionTurnActivity | null | undefined
}

export type SubscriberLiveText = {
  journal: AgentSessionJournal
  fence: number
  items: readonly AgentJournalRenderItem[]
  hostNow: number
}

type LaneEntry =
  | { kind: 'ordered'; since: number; run: () => Promise<unknown> }
  | { kind: 'catch-up'; since: number; catchUp: SubscriberCatchUp }
  | { kind: 'background-tasks'; since: number; fence: number }
  | { kind: 'live-text'; since: number; liveText: SubscriberLiveText }

export type SubscriberDeliveryLaneRunners = {
  catchUp: (catchUp: SubscriberCatchUp) => Promise<unknown>
  backgroundTasks: (fence: number) => Promise<unknown>
  liveText: (liveText: SubscriberLiveText) => Promise<unknown>
  /** Undefined when the two cannot be one delivery. */
  mergeCatchUp: (
    pending: SubscriberCatchUp,
    next: SubscriberCatchUp
  ) => SubscriberCatchUp | undefined
  runnable: () => boolean
  failed: (error: unknown) => void
  now: () => number
}

export type SubscriberDeliveryRetention = {
  pending: number
  oldestMs: number
  liveTextBytes: number
}

/**
 * One delivery runs at a time. Replaceable work waiting behind it coalesces, so a stalled
 * transport retains at most the active delivery, one catch-up, one background refresh and the
 * latest live text per run of ordered work, never every superseded snapshot.
 */
export class SubscriberDeliveryLane {
  private readonly pending: LaneEntry[] = []
  private active: LaneEntry | undefined
  private scheduled = false
  /** Live text the running delivery holds, whether a live-text entry or sent by ordered work. */
  private delivering: readonly AgentJournalRenderItem[] | undefined
  private readonly stop = new AbortController()
  readonly stopped = this.stop.signal

  constructor(private readonly runners: SubscriberDeliveryLaneRunners) {}

  get idle(): boolean {
    return !this.active && !this.scheduled && this.pending.length === 0
  }

  /** Catch-ups and refreshes never merge across ordered work: it may reset what they read from. */
  ordered(run: () => Promise<unknown>): void {
    this.add({ kind: 'ordered', since: this.runners.now(), run })
  }

  catchUp(next: SubscriberCatchUp): void {
    const index = this.openIndex('catch-up')
    const entry = index === undefined ? undefined : this.pending[index]
    const merged =
      entry?.kind === 'catch-up' ? this.runners.mergeCatchUp(entry.catchUp, next) : undefined
    if (entry?.kind === 'catch-up' && merged) {
      entry.catchUp = merged
      return
    }
    this.add({ kind: 'catch-up', since: this.runners.now(), catchUp: next })
  }

  /** The refresh reads current state when it runs; the newest fence stands. */
  backgroundTasks(fence: number): void {
    const index = this.openIndex('background-tasks')
    const entry = index === undefined ? undefined : this.pending[index]
    if (entry?.kind === 'background-tasks') {
      entry.fence = fence
      return
    }
    this.add({ kind: 'background-tasks', since: this.runners.now(), fence })
  }

  /**
   * Each snapshot replaces the whole live text, so only the newest still waiting is kept, even
   * across ordered work: an opening or snapshot republishes the current live text itself.
   */
  liveText(liveText: SubscriberLiveText): void {
    if (this.stopped.aborted) {
      return
    }
    const since = this.dropWaitingLiveText() ?? this.runners.now()
    // A stream holding more than its cap ends itself and its client resumes; no other is evicted.
    const delivering = this.delivering ? heldBytesOf(this.delivering) : 0
    if (heldBytesOf(liveText.items) + delivering > CHAT_LIVE_TEXT_SUBSCRIBER_BYTES) {
      this.refuse()
      return
    }
    this.add({ kind: 'live-text', since, liveText })
  }

  /** Ordered work (an opening or snapshot) sending live text itself; false past the stream's cap. */
  sendsLiveText(items: readonly AgentJournalRenderItem[]): boolean {
    if (this.stopped.aborted) {
      return false
    }
    const adopts = this.active?.kind === 'ordered'
    if (adopts) {
      // It sends the current live text, at least as new as any waiting, which would only repeat it.
      this.dropWaitingLiveText()
    }
    const waiting = this.pending.find((entry) => entry.kind === 'live-text')
    const queued = waiting?.kind === 'live-text' ? heldBytesOf(waiting.liveText.items) : 0
    if (heldBytesOf(items) + queued > CHAT_LIVE_TEXT_SUBSCRIBER_BYTES) {
      this.refuse()
      return false
    }
    if (adopts) {
      this.delivering = items
    }
    return true
  }

  /** Returns when the dropped live text started waiting. */
  private dropWaitingLiveText(): number | undefined {
    const index = this.pending.findIndex((entry) => entry.kind === 'live-text')
    const dropped = index === -1 ? undefined : this.pending.splice(index, 1)[0]
    return dropped?.kind === 'live-text' ? dropped.since : undefined
  }

  private refuse(): void {
    noteLiveTextCapReached()
    this.runners.failed(new SubscriberLiveTextCapReached())
    this.clear()
  }

  /** Releases waiting work and withdraws queued reads; the active delivery gets no more frames. */
  clear(): void {
    this.pending.length = 0
    this.stop.abort()
  }

  /** `counted` spans one sample: subscribers of one chat share each snapshot, counted once. */
  retention(now: number, counted: Set<object>): SubscriberDeliveryRetention {
    const entries = this.active ? [this.active, ...this.pending] : this.pending
    // `delivering` covers an active live-text entry and live text an opening or snapshot sends.
    const held = this.pending.flatMap((entry) =>
      entry.kind === 'live-text' ? [entry.liveText.items] : []
    )
    if (this.delivering) {
      held.push(this.delivering)
    }
    let liveTextBytes = 0
    for (const items of held) {
      if (!counted.has(items)) {
        counted.add(items)
        liveTextBytes += heldBytesOf(items)
      }
    }
    const oldest = entries.reduce((since, entry) => Math.min(since, entry.since), now)
    return { pending: entries.length, oldestMs: now - oldest, liveTextBytes }
  }

  private openIndex(kind: LaneEntry['kind']): number | undefined {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const entry = this.pending[index]!
      if (entry.kind === kind) {
        return index
      }
      if (entry.kind === 'ordered') {
        return undefined
      }
    }
    return undefined
  }

  private add(entry: LaneEntry): void {
    this.pending.push(entry)
    if (!this.active && !this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => void this.drain())
    }
  }

  private async drain(): Promise<void> {
    this.scheduled = false
    while (!this.active) {
      const entry = this.pending.shift()
      if (!entry) {
        return
      }
      this.active = entry
      this.delivering = entry.kind === 'live-text' ? entry.liveText.items : undefined
      try {
        if (this.runners.runnable()) {
          await this.run(entry)
        }
      } catch (error) {
        this.runners.failed(error)
      } finally {
        this.active = undefined
        this.delivering = undefined
      }
    }
  }

  private run(entry: LaneEntry): Promise<unknown> {
    switch (entry.kind) {
      case 'ordered':
        return entry.run()
      case 'catch-up':
        return this.runners.catchUp(entry.catchUp)
      case 'background-tasks':
        return this.runners.backgroundTasks(entry.fence)
      case 'live-text':
        return this.runners.liveText(entry.liveText)
    }
  }
}
