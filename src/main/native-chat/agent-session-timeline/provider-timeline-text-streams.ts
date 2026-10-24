import {
  planProviderTimelineText,
  providerTimelineStreamTurn
} from './provider-timeline-text-write'
// Streamed text, as message rows.
//
// A named stream is the item with that id on its thread, so its deltas, its close and any full
// snapshot of it are one row. An anonymous stream becomes a new message each time it starts, and
// its identity is its name, thread, channel and producer: a change to any starts the next
// message. Deltas accumulate in the shared coalescer, and a row is a snapshot of the text so far.
// Text owed to the journal is written inside the next event's transition — every other event is
// an ordering barrier — or by the coalescer's window, and is marked written once the sink takes it.
// Every write first reads the turn its row is in: once any writer settled that turn (a person's
// Stop, the turn's own end), the stream writes nothing more. A stream stopped that way keeps its
// key until the turn's boundary, so the provider's trailing deltas drop rather than start a
// message outside the stopped turn.

import type {
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaWindow,
  type AgentSessionDeltaCoalescerDeps
} from '../agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineEntryBytes,
  providerTimelinePlacement,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineJoin,
  ProviderTimelineTextChannel,
  ProviderTimelineTextItem
} from './provider-timeline-event'
import { providerTimelineKeyPart } from './provider-timeline-identity'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import {
  providerKey,
  providerTimelineTurnRowState,
  turnOf,
  type ProviderTimelineRowId
} from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'

export type ProviderTimelineStream = {
  id: string
  /** Named streams share their item’s budget slot. */
  key: string
  row: ProviderTimelineRowId
  /** New rows use this scope; existing rows retain theirs. */
  scope: AgentJournalTurnScope
  named: boolean
  channel: ProviderTimelineTextChannel
  producer: AgentJournalProducerLinkage | undefined
  /** Whitespace-only streams cannot complete a message. */
  written: boolean
  bytes: number
  /** Once a write finds a settled turn, later text cannot land. */
  stoppedIn: string | null
}

/** Retain stopped keys until the turn boundary, within this bound. */
const MAX_STOPPED_STREAMS = 128

export class ProviderTimelineTextStreams {
  private readonly streams = new Map<string, ProviderTimelineStream>()
  private readonly byId = new Map<string, ProviderTimelineStream>()
  private readonly stopped = new Map<string, string>()
  private readonly coalescer

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
      source: (id) => {
        const stream = this.byId.get(id)
        return stream ? deps.sink.textSource?.(stream.row.identity) : undefined
      },
      // Every stream here is one this assembler holds open; the shared budget counts them.
      isProtected: () => true,
      emit: (id, text) => this.flushOnWindow(id, text),
      emitDelta: (id, window) => this.flushOnWindow(id, '', window)
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
    return stream
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
      named,
      channel: input.channel,
      producer: input.producer,
      written: false,
      bytes: providerTimelineEntryBytes({
        key: 'id' in input.item ? input.item.id : input.item.stream,
        join: input.join,
        producer: input.producer
      }),
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
    })
  }

  /** Flush preceding text before the event’s own writes. */
  planFlush(plan: ProviderTimelinePlan, except?: ProviderTimelineStream): void {
    for (const { key, window } of this.coalescer.dirtyWindows()) {
      const stream = this.byId.get(key)
      if (stream && stream !== except) {
        this.planText(plan, stream, '', window)
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

  /** Settled-turn streams hold no budget because none of their text can land. */
  stopSettled(journal: StructuredAgentSessionTransitionJournal): void {
    for (const stream of this.open) {
      const turn = providerTimelineStreamTurn(stream, journal)
      if (turn !== null && providerTimelineTurnRowState(journal, turn) === 'settled') {
        this.stop(stream, turn)
      }
    }
  }

  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean,
    finalize = true
  ): void {
    const released = [...this.streams.values()].filter(which)
    for (const stream of finalize ? released : []) {
      this.planText(plan, stream, '', undefined, true)
    }
    if (released.length > 0) {
      plan.onAdmitted(() => released.forEach((stream) => this.forget(stream)))
    }
  }

  planClose(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, finalText?: string): void {
    if (finalText === undefined) {
      this.planText(plan, stream, '', undefined, true)
    } else {
      this.planText(plan, stream, finalText, undefined, true, true)
    }
    this.planRelease(plan, (each) => each === stream, false)
  }

  flush(): void {
    this.coalescer.flushAll()
  }

  /** Drops buffered text; apply session.ended first to flush it. */
  dispose(): void {
    Array.from(this.byId.values()).forEach((stream) => this.forget(stream))
    this.stopped.clear()
    this.coalescer.dispose()
  }

  /** The window's flush: false keeps the text for a retry, but only while the sink is merely full. */
  private flushOnWindow(id: string, text: string, window?: AgentSessionDeltaWindow): boolean {
    const stream = this.byId.get(id)
    if (!stream) {
      return true
    }
    const plan = new ProviderTimelinePlan()
    this.planText(plan, stream, text, window)
    const admission = plan.submit(this.deps.sink)
    return admission.accepted || admission.reason !== 'backpressure'
  }

  private planText(
    plan: ProviderTimelinePlan,
    stream: ProviderTimelineStream,
    text: string,
    window?: AgentSessionDeltaWindow,
    finish = false,
    authoritative = false
  ): void {
    planProviderTimelineText(
      this.deps.sink,
      this.coalescer,
      plan,
      stream,
      text,
      window,
      finish,
      authoritative
    )
  }

  private stop(stream: ProviderTimelineStream, turnItemId: string): void {
    stream.stoppedIn = turnItemId
    this.forget(stream)
    this.stopped.delete(stream.key)
    this.stopped.set(stream.key, turnItemId)
    for (const [oldest] of [...this.stopped].slice(
      0,
      Math.max(0, this.stopped.size - MAX_STOPPED_STREAMS)
    )) {
      this.stopped.delete(oldest)
    }
  }

  private forget(stream: ProviderTimelineStream): void {
    this.coalescer.forget(stream.id)
    if (this.streams.get(stream.key) === stream) {
      this.streams.delete(stream.key)
    }
    this.byId.delete(stream.id)
  }
}
