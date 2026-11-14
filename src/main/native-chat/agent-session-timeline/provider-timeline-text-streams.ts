// Named deltas/snapshots share one row; anonymous stream identity changes start new messages.
// Flush text at event barriers or coalescing windows. Recheck turn settlement on every write,
// retaining stopped keys until their boundary so trailing deltas cannot escape into thread messages.

import type {
  AgentJournalRenderItem,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  providerTimelinePlacement,
  providerTimelineScopeItemIds,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineJoin,
  ProviderTimelineTextChannel,
  ProviderTimelineTextItem
} from './provider-timeline-event'
import {
  providerTimelineLiveText,
  providerTimelineTextBody,
  type ProviderTimelineStream
} from './provider-timeline-text-stream'
import { splitProviderTimelineTextBlocks } from './provider-timeline-text-blocks'
import { providerTimelineKeyPart } from './provider-timeline-identity'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { providerKey, turnOf } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'

export class ProviderTimelineTextStreams {
  private readonly streams = new Map<string, ProviderTimelineStream>()
  private readonly byId = new Map<string, ProviderTimelineStream>()
  private readonly stopped = new Map<string, string>()
  private readonly coalescer
  private readonly releaseLiveText: (() => void) | undefined

  constructor(
    private readonly deps: {
      sink: ProviderTimelineSink
      context: ProviderTimelineContext
      coalesceMs?: number
      schedule?: AgentSessionDeltaCoalescerDeps['schedule']
    }
  ) {
    this.coalescer = createAgentSessionDeltaCoalescer({
      ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
      // Live identities must survive until the provider closes them or their turn ends.
      isProtected: () => true,
      emit: (id, text) => this.flushOnWindow(id, text)
    })
    this.releaseLiveText = deps.sink.bindLiveText?.({
      read: (epoch) => this.liveText(epoch),
      flush: () => this.flush()
    })
  }

  get open(): readonly ProviderTimelineStream[] {
    return [...this.streams.values()].filter((stream) => stream.stoppedIn === null)
  }

  key(item: ProviderTimelineTextItem, join: ProviderTimelineJoin | undefined): string {
    const thread = join?.thread ?? null
    return 'id' in item
      ? this.deps.context.rows.item('item', providerKey(item.id), thread).itemId
      : `stream:${providerTimelineKeyPart(thread ?? '')}:${providerTimelineKeyPart(item.stream)}`
  }

  /** Release stopped streams while retaining their stopped keys. */
  get(key: string): ProviderTimelineStream | undefined {
    const stream = this.streams.get(key)
    if (stream?.stoppedIn) {
      this.stop(stream, stream.stoppedIn)
      return undefined
    }
    return stream?.closing ? undefined : stream
  }

  /** Drop trailing text for the same stopped turn, including events naming no turn. */
  stoppedFor(key: string, join: ProviderTimelineJoin | undefined): boolean {
    const turn = this.stopped.get(key)
    return (
      turn !== undefined &&
      (join?.turn === undefined ||
        this.deps.context.rows.turn(providerKey(join.turn)).itemId === turn)
    )
  }

  /** Prepare without admission; serial supplies the stream and anonymous row identity. */
  start(input: {
    item: ProviderTimelineTextItem
    join: ProviderTimelineJoin | undefined
    channel: ProviderTimelineTextChannel
    producer: AgentJournalProducerLinkage | undefined
    state: ProviderTimelineState
    serial: number
  }): ProviderTimelineStream {
    const { rows } = this.deps.context
    const thread = input.join?.thread ?? null
    const named = 'id' in input.item
    const key = 'id' in input.item ? providerKey(input.item.id) : rows.minted('s', input.serial)
    return {
      id: `s${input.serial}`,
      key: this.key(input.item, input.join),
      row: rows.item('item', key, thread),
      scope: providerTimelinePlacement(this.deps.context, input.state, input.join),
      scopeItemIds: providerTimelineScopeItemIds(this.deps.context, input.join),
      named,
      channel: input.channel,
      producer: input.producer,
      committed: null,
      queuedLength: 0,
      savedAt: 0,
      pending: 0,
      closing: false,
      stoppedIn: null
    }
  }

  continues(
    stream: ProviderTimelineStream,
    channel: ProviderTimelineTextChannel,
    producer: AgentJournalProducerLinkage | undefined
  ): boolean {
    return stream.channel === channel && stream.producer?.agentId === producer?.agentId
  }

  planAppend(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, text: string): void {
    plan.onAdmitted(() => {
      if (!this.byId.has(stream.id)) {
        this.streams.set(stream.key, stream)
        this.byId.set(stream.id, stream)
      }
      this.coalescer.append(stream.id, text)
      const snapshot = this.coalescer.snapshot(stream.id)
      if (stream.queuedLength === 0 && snapshot && snapshot.text.trim().length > 0) {
        const start = new ProviderTimelinePlan()
        this.planText(start, stream, snapshot.text)
        start.submit(this.deps.sink)
      }
    })
  }

  /** Flush preceding text before the event’s own writes. */
  planFlush(plan: ProviderTimelinePlan, except?: ProviderTimelineStream): void {
    for (const stream of this.byId.values()) {
      if (stream.closing) {
        continue
      }
      const snapshot = this.coalescer.snapshot(stream.id)
      if (snapshot && stream !== except && snapshot.text.length !== stream.queuedLength) {
        this.planText(plan, stream, snapshot.text)
      }
    }
  }

  /** Stop externally settled streams only when the event is admitted. */
  planStop(plan: ProviderTimelinePlan, turnItemId: string): void {
    const stopped = [...this.streams.values()].filter(
      (stream) => turnOf(stream.scope) === turnItemId
    )
    if (stopped.length > 0) {
      plan.onAdmitted(() => stopped.forEach((stream) => this.stop(stream, turnItemId)))
    }
  }

  /** Release stopped keys at their turn boundary; null covers every turn. */
  planBoundary(plan: ProviderTimelinePlan, turnItemId: string | null): void {
    plan.onAdmitted(() => {
      for (const [key, turn] of this.stopped) {
        if (turnItemId === null || turn === turnItemId) {
          this.stopped.delete(key)
        }
      }
    })
  }

  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean
  ): void {
    const released = [...this.streams.values()].filter(which)
    if (released.length > 0) {
      plan.onAdmitted(() =>
        released.forEach((stream) => {
          stream.closing = true
        })
      )
      plan.onPublished(() => released.forEach((stream) => this.forget(stream)))
    }
  }

  planClose(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, finalText?: string): void {
    if (finalText === undefined) {
      const owed = this.coalescer.snapshot(stream.id)
      if (owed && owed.text.length !== stream.queuedLength) {
        this.planText(plan, stream, owed.text)
      }
    } else {
      this.planText(plan, stream, finalText, true)
    }
    this.planRelease(plan, (each) => each === stream)
  }

  flush(): void {
    const plan = new ProviderTimelinePlan()
    this.planFlush(plan)
    plan.submit(this.deps.sink)
    this.coalescer.flushAll()
  }

  /** Drops buffered text; apply session.ended first to flush it. */
  dispose(): void {
    const finish = (): void => {
      Array.from(this.byId.values()).forEach((stream) => this.forget(stream))
      this.stopped.clear()
      this.releaseLiveText?.()
      this.coalescer.dispose()
    }
    const written = this.deps.sink.written?.()
    if (written) {
      void written.then((result) => {
        if (result.ok) {
          finish()
        }
      })
    } else {
      finish()
    }
  }

  /** Retain refused text only for retryable backpressure. */
  private flushOnWindow(id: string, text: string): boolean {
    const stream = this.byId.get(id)
    if (!stream) {
      return true
    }
    if (stream.closing || stream.stoppedIn !== null) {
      return true
    }
    const now = Date.now()
    if (stream.pending === 0 && (stream.queuedLength === 0 || now - stream.savedAt >= 400)) {
      const ready = stream.queuedLength === 0 ? text : splitProviderTimelineTextBlocks(text).ready
      if (ready.length > stream.queuedLength) {
        const plan = new ProviderTimelinePlan()
        this.planText(plan, stream, ready)
        const admission = plan.submit(this.deps.sink)
        if (!admission.accepted && admission.reason === 'backpressure') {
          return false
        }
      }
    }
    const admission = this.deps.sink.publishLiveText?.()
    return admission?.accepted !== false || admission.reason !== 'backpressure'
  }

  private liveText(epoch: string): AgentJournalRenderItem[] {
    return [...this.byId.values()].flatMap((stream) =>
      providerTimelineLiveText(stream, epoch, this.coalescer.snapshot(stream.id))
    )
  }

  private planText(
    plan: ProviderTimelinePlan,
    stream: ProviderTimelineStream,
    text: string,
    providerFinal = false
  ): void {
    const empty = providerFinal ? text.length === 0 : text.trim().length === 0
    if (stream.queuedLength === 0 && empty) {
      plan.onAdmitted(() => this.coalescer.markFlushed(stream.id))
      return
    }
    const body = providerTimelineTextBody(stream, text)
    plan.item(
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(stream.row.identity, body),
        resolution: {
          kind: 'text-snapshot',
          identity: stream.row.identity,
          body,
          scopeItemIds: stream.scopeItemIds
        },
        options: { ...stream.producer, turnScope: stream.scope }
      },
      false,
      (outcome, committed) => {
        stream.pending = Math.max(0, stream.pending - 1)
        if (outcome.kind === 'committed' && outcome.wrote) {
          stream.savedAt = Date.now()
          const item = committed.items?.find((item) => item.itemId === stream.row.itemId)
          if (item && committed.cursor) {
            const { body: _body, ...placement } = item
            stream.committed = { epoch: committed.cursor.epoch, placement }
          }
        }
        if (
          outcome.kind === 'dropped' &&
          outcome.turnItemId &&
          this.streams.get(stream.key) === stream
        ) {
          this.stop(stream, outcome.turnItemId)
        }
      }
    )
    plan.onAdmitted(() => {
      stream.queuedLength = text.length
      stream.pending += 1
    })
    plan.onPublished(() => {
      this.deps.sink.publishLiveText?.()
    })
  }

  private stop(stream: ProviderTimelineStream, turnItemId: string): void {
    stream.stoppedIn = turnItemId
    this.forget(stream)
    this.stopped.delete(stream.key)
    this.stopped.set(stream.key, turnItemId)
  }

  private forget(stream: ProviderTimelineStream): void {
    this.coalescer.forget(stream.id)
    if (this.streams.get(stream.key) === stream) {
      this.streams.delete(stream.key)
    }
    this.byId.delete(stream.id)
  }
}
