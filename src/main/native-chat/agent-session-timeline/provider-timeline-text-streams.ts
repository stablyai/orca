// Named deltas/snapshots share one row; anonymous stream identity changes start new messages.
// Flush text at event barriers or coalescing windows. Recheck turn settlement on every write,
// retaining stopped keys until their boundary so trailing deltas cannot escape into thread messages.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalProducerLinkage,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
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
      // The assembler’s shared budget already counts these protected streams.
      isProtected: () => true,
      emit: (id, text) => this.flushOnWindow(id, text)
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
    for (const { key, snapshot } of this.coalescer.dirty()) {
      const stream = this.byId.get(key)
      if (stream && stream !== except) {
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

  /** Settled-turn streams hold no budget because none of their text can land. */
  stopSettled(journal: StructuredAgentSessionTransitionJournal): void {
    for (const stream of this.open) {
      const turn = this.rowTurn(stream, journal)
      if (turn !== null && providerTimelineTurnRowState(journal, turn) === 'settled') {
        this.stop(stream, turn)
      }
    }
  }

  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean
  ): void {
    const released = [...this.streams.values()].filter(which)
    if (released.length > 0) {
      plan.onAdmitted(() => released.forEach((stream) => this.forget(stream)))
    }
  }

  planClose(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, finalText?: string): void {
    if (finalText === undefined) {
      const owed = this.coalescer.dirty().find(({ key }) => key === stream.id)
      if (owed) {
        this.planText(plan, stream, owed.snapshot.text)
      }
    } else {
      this.planText(plan, stream, finalText, true)
    }
    this.planRelease(plan, (each) => each === stream)
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

  /** Retain refused text only for retryable backpressure. */
  private flushOnWindow(id: string, text: string): boolean {
    const stream = this.byId.get(id)
    if (!stream) {
      return true
    }
    const plan = new ProviderTimelinePlan()
    this.planText(plan, stream, text)
    const admission = plan.submit(this.deps.sink)
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

  /** Recheck every write so no stream appends after any writer settles its turn. */
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

  /** Prefer the persisted scope, otherwise the pending row’s placement. */
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
