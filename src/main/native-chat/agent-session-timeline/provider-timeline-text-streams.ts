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

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalProducerLinkage,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../agent-session-journal/journal-payload-bounds'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../agent-session-wire/agent-session-delta-coalescer'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineEntryBytes,
  providerTimelinePlacement,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type { ProviderTimelineResolvedWrite } from './provider-timeline-decision'
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

/** One open text stream. */
export type ProviderTimelineStream = {
  /** The coalescer's key, unique per stream. */
  id: string
  /** The stream's slot: a named stream's is its item's row id, which the budget shares. */
  key: string
  row: ProviderTimelineRowId
  /** The turn its row joins when it is new; an existing row keeps its own. */
  scope: AgentJournalTurnScope
  named: boolean
  channel: ProviderTimelineTextChannel
  producer: AgentJournalProducerLinkage | undefined
  /** Whether any text was written; a whitespace-only stream completes nothing. */
  written: boolean
  bytes: number
  /** The settled turn a write found its row in: it writes nothing more. */
  stoppedIn: string | null
}

/** Stopped streams remembered until their turn's boundary; past this the oldest is forgotten. */
const MAX_STOPPED_STREAMS = 128

export class ProviderTimelineTextStreams {
  private readonly streams = new Map<string, ProviderTimelineStream>()
  private readonly byId = new Map<string, ProviderTimelineStream>()
  /** Keys of streams stopped by their turn's settlement, to that turn's row id. */
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
      // Every stream here is one this assembler holds open; the shared budget counts them.
      isProtected: () => true,
      emit: (id, text) => this.flushOnWindow(id, text)
    })
  }

  /** What the budget counts: one entry per open stream. */
  get open(): readonly ProviderTimelineStream[] {
    return [...this.streams.values()].filter((stream) => stream.stoppedIn === null)
  }

  /** The stream slot `item` names on its thread. */
  key(item: ProviderTimelineTextItem, join: ProviderTimelineJoin | undefined): string {
    const thread = join?.thread ?? null
    return 'id' in item
      ? this.deps.context.rows.item('item', providerKey(item.id), thread).itemId
      : `stream:${providerTimelineKeyPart(thread ?? '')}:${providerTimelineKeyPart(item.stream)}`
  }

  /** The open stream in `key`; a stopped one is let go and its key kept as stopped. */
  get(key: string): ProviderTimelineStream | undefined {
    const stream = this.streams.get(key)
    if (stream?.stoppedIn) {
      this.stop(stream, stream.stoppedIn)
      return undefined
    }
    return stream
  }

  /** Whether text for `key` would continue a stream its turn's settlement stopped: it names no
   *  turn, or names that one. */
  stoppedFor(key: string, join: ProviderTimelineJoin | undefined): boolean {
    const turn = this.stopped.get(key)
    return (
      turn !== undefined &&
      (join?.turn === undefined ||
        this.deps.context.rows.turn(providerKey(join.turn)).itemId === turn)
    )
  }

  /** A new stream, not yet open; `serial` names it (and an anonymous one's row). */
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

  /** Whether a delta on `stream` continues it or begins another message. */
  continues(
    stream: ProviderTimelineStream,
    channel: ProviderTimelineTextChannel,
    producer: AgentJournalProducerLinkage | undefined
  ): boolean {
    return stream.channel === channel && stream.producer?.agentId === producer?.agentId
  }

  /** The delta's text; the stream opens when the event is admitted. */
  planAppend(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, text: string): void {
    plan.onAdmitted(() => {
      if (!this.byId.has(stream.id)) {
        this.streams.set(stream.key, stream)
        this.byId.set(stream.id, stream)
      }
      this.coalescer.append(stream.id, text)
    })
  }

  /** Every stream's unwritten text, ahead of whatever the event writes. */
  planFlush(plan: ProviderTimelinePlan, except?: ProviderTimelineStream): void {
    for (const { key, snapshot } of this.coalescer.dirty()) {
      const stream = this.byId.get(key)
      if (stream && stream !== except) {
        this.planText(plan, stream, snapshot.text)
      }
    }
  }

  /** Stops every stream of a turn another writer settled once the event is admitted: their text
   *  can never land. */
  planStop(plan: ProviderTimelinePlan, turnItemId: string): void {
    const stopped = [...this.streams.values()].filter(
      (stream) => turnOf(stream.scope) === turnItemId
    )
    if (stopped.length > 0) {
      plan.onAdmitted(() => stopped.forEach((stream) => this.stop(stream, turnItemId)))
    }
  }

  /** A turn's boundary: what its settlement stopped no longer holds the key; null is every turn. */
  planBoundary(plan: ProviderTimelinePlan, turnItemId: string | null): void {
    plan.onAdmitted(() => {
      for (const [key, turn] of this.stopped) {
        if (turnItemId === null || turn === turnItemId) {
          this.stopped.delete(key)
        }
      }
    })
  }

  /** Before the budget refuses: a stream whose row's turn the journal shows settled holds nothing,
   *  since none of its text can land. */
  stopSettled(journal: StructuredAgentSessionTransitionJournal): void {
    for (const stream of this.open) {
      const turn = this.rowTurn(stream, journal)
      if (turn !== null && providerTimelineTurnRowState(journal, turn) === 'settled') {
        this.stop(stream, turn)
      }
    }
  }

  /** Ends the streams `which` selects once the event is admitted; their text was flushed by it. */
  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean
  ): void {
    const released = [...this.streams.values()].filter(which)
    if (released.length > 0) {
      plan.onAdmitted(() => released.forEach((stream) => this.forget(stream)))
    }
  }

  /** Ends one stream with the provider's final text, else what streamed. */
  planClose(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, finalText?: string): void {
    if (finalText === undefined) {
      const owed = this.coalescer.dirty().find(({ key }) => key === stream.id)
      if (owed) {
        this.planText(plan, stream, owed.snapshot.text)
      }
    } else {
      const text = boundInlineText(finalText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      this.planText(plan, stream, text, true)
    }
    this.planRelease(plan, (each) => each === stream)
  }

  flush(): void {
    this.coalescer.flushAll()
  }

  /** Drops the window's unwritten text: apply `session.ended` first, which writes it. */
  dispose(): void {
    Array.from(this.byId.values()).forEach((stream) => this.forget(stream))
    this.stopped.clear()
    this.coalescer.dispose()
  }

  /** The window's flush: false keeps the text for a retry, but only while the sink is merely full. */
  private flushOnWindow(id: string, text: string): boolean {
    const stream = this.byId.get(id)
    if (!stream) {
      return true
    }
    const plan = new ProviderTimelinePlan()
    this.planText(plan, stream, text)
    const admission = plan.submit(this.deps.sink)
    // A failed or closed sink can never take it; the session's end owns what it leaves.
    return admission.accepted || admission.reason !== 'backpressure'
  }

  private planText(
    plan: ProviderTimelinePlan,
    stream: ProviderTimelineStream,
    text: string,
    providerFinal = false
  ): void {
    const empty = providerFinal ? text.length === 0 : text.trim().length === 0
    if (!stream.written && empty) {
      plan.onAdmitted(() => this.coalescer.markFlushed(stream.id))
      return
    }
    const body = this.message(stream, text)
    plan.item({
      reservedBytes: estimateStructuredAgentSessionItemBytes(stream.row.identity, body),
      resolve: (journal) => this.resolveText(stream, body, journal),
      options: { ...stream.producer, turnScope: stream.scope }
    })
    plan.onAdmitted(() => {
      stream.written = true
      this.coalescer.markFlushed(stream.id)
    })
  }

  /** Every write, not only the first: whoever ended the row's turn since, this run or another
   *  writer of the journal, the stream never writes into it again. */
  private resolveText(
    stream: ProviderTimelineStream,
    body: AgentJournalItemBody,
    journal: StructuredAgentSessionTransitionJournal
  ): ProviderTimelineResolvedWrite | null {
    if (stream.stoppedIn !== null) {
      return null
    }
    const turn = this.rowTurn(stream, journal)
    if (turn !== null && providerTimelineTurnRowState(journal, turn) === 'settled') {
      stream.stoppedIn = turn
      return null
    }
    return { identity: stream.row.identity, body }
  }

  /** The turn the stream's row is in: the journal's for a written row, else where it would go. */
  private rowTurn(
    stream: ProviderTimelineStream,
    journal: StructuredAgentSessionTransitionJournal
  ): string | null {
    const held = journal.item(stream.row.itemId)
    return turnOf(held ? (held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : stream.scope)
  }

  private message(stream: ProviderTimelineStream, text: string): AgentJournalItemBody {
    return {
      kind: 'message',
      role: stream.channel === 'assistant' ? 'assistant' : 'reasoning',
      blocks: [{ type: 'text', text }]
    }
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
