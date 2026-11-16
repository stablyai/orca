import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { describeWorkerMessage } from '../../../../worker-threads/worker-message-shape'

/** Reads every row after the subscriber's cursor when it runs, so a later one covers an earlier one. */
export type SubscriberCatchUp = {
  journal: AgentSessionJournal
  port: SubscriberDeliveryPort
  /** The same fan-out's port with a queue read, shared by every subscriber that still owes one. */
  queuePort: () => SubscriberDeliveryPort
  queueChanged: boolean
  hostNow: number
  activity?: AgentSessionTurnActivity | null
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
  private readonly stop = new AbortController()
  readonly stopped = this.stop.signal

  constructor(private readonly runners: SubscriberDeliveryLaneRunners) {}

  get idle(): boolean {
    return !this.active && !this.scheduled && this.pending.length === 0
  }

  /** Coalescing never crosses ordered work: it may reset what later work reads from. */
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

  /** Each snapshot replaces the whole live text, so only the newest still waiting is kept. */
  liveText(liveText: SubscriberLiveText): void {
    const index = this.pending.findIndex((entry) => entry.kind === 'live-text')
    const since = index === -1 ? this.runners.now() : this.pending[index]!.since
    if (index !== -1) {
      this.pending.splice(index, 1)
    }
    this.add({ kind: 'live-text', since, liveText })
  }

  /** Releases waiting work and withdraws queued reads; the active delivery gets no more frames. */
  clear(): void {
    this.pending.length = 0
    this.stop.abort()
  }

  /** `measured` spans one sample: subscribers of one chat share each snapshot, measured once. */
  retention(now: number, measured: Map<object, number>): SubscriberDeliveryRetention {
    const entries = this.active ? [this.active, ...this.pending] : this.pending
    let liveTextBytes = 0
    for (const entry of entries) {
      if (entry.kind === 'live-text') {
        const { items } = entry.liveText
        let bytes = measured.get(items)
        if (bytes === undefined) {
          bytes = describeWorkerMessage(items).bytes
          measured.set(items, bytes)
        }
        liveTextBytes += bytes
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
      try {
        if (this.runners.runnable()) {
          await this.run(entry)
        }
      } catch (error) {
        this.runners.failed(error)
      } finally {
        this.active = undefined
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
