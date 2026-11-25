import type { Readable } from 'node:stream'
import { jsonProperty } from '../../shared/json-stream/json-value-property'
import type * as RelayProtocol from '../daemon/protocol/daemon-provider-relay-protocol'
import { RelayedProviderConsumption } from './relayed-provider-consumption'
import { boundedCutKeys } from './relayed-provider-cut-keys'
import { RelayedProviderKeptLines, relayHandOffWaitMs } from './relayed-provider-kept-lines'
import type { RelayedProviderContinuation } from './relayed-provider-continuation'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'

/** Acks batch this long after output; the daemon asks sooner (relayAckWanted) when it holds a lot. */
const ACK_DELAY_MS = 1_000
const seqOf = (value: unknown): number => (typeof value === 'number' ? value : 0)
/**
 * A held replay is handed on in slices of about this much text, yielding between them: the
 * stream hands a slice to its reader in one run, so the slice bounds main's longest run.
 */
const RELEASE_SLICE_CHARS = 64 * 1024

/**
 * The provider's view of its open streamed items: it sees every agent line with its seq before the
 * line is handed on, and names the seq of the earliest item still open. Acks stay below it, so a
 * reattach replays that item whole onto its own row (rows are keyed by the provider's own ids).
 */
export type ProviderRelayAckFloor = {
  observe: (seq: number, line: string) => void
  /** The first line still needed after a crash, for an ack covering lines through `through`;
   *  items starting at or before `released` (let go already) are held no more. */
  floor: (through?: number, released?: number) => number | null
  /** True once after the floor rose past an open item's start on purpose (its replay will be cut). */
  tookCut?: () => boolean
  /** A forced ack (the daemon's file cap) released everything through `seq`: items it held that
   *  started there can't be kept whole any more, so they hold nothing from now on. */
  released?: (seq: number) => void
  /** The items a cut now splits, as the continuation keys them; a reattach moves exactly those.
   *  `through`: a release lets go of lines through it, splitting items open there too. */
  cutKeys?: (through?: number) => string[]
  /** Given once a way to ask for an ack, for a floor that drops without a new line. */
  wake?: (ack: () => void) => void
}

export type ProviderRelayAckFlags = { cut?: true; held?: true; cutKeys?: string[] }

type OutputOptions = {
  ackFloor?: ProviderRelayAckFloor
  stdout: Readable
  /** Holds output until `release()`, except the lines this lets through (answers to new requests). */
  passWhileHeld?: (line: string) => boolean
  /**
   * True once everything handed on is saved; false (streamed text still live) or a rejection
   * leaves it unacked. `force` saves live text first, for when the daemon needs the ack.
   */
  durable?: (force: boolean) => Promise<boolean>
  /** `keepFrom`: the daemon keeps lines from it on for a later attach, though `seq` is received. */
  /**
   * `cut`: this ack gives up an open kept span. `held`: the kept lines are a held replay the
   * journal can't save yet. The reply's `ackedThrough` says how far the daemon really released.
   */
  ack: (seq: number, keepFrom?: number, flags?: ProviderRelayAckFlags) => Promise<unknown>
  /** A shared tick for the next ack (one timer per daemon connection); its own timer otherwise. */
  scheduleAck?: (run: () => void) => () => void
}

/**
 * A relay's output cursor: lines in seq order onto stdout, each request once, and acks that only
 * cover what the consumer was handed and the journal holds.
 */
export class RelayedProviderOutput {
  /** The agent's answer to the first client's `initialize`, when the relay was reattached. */
  initializeLine: string | null = null
  readonly kept = new RelayedProviderKeptLines()
  /** Highest data seq handed on or held; spool lines at or below it are already seen. */
  private deliveredSeq = 0
  /** Highest data seq actually handed on; the next attach and every ack start here. */
  private pushedSeq = 0
  private ackedSeq = 0
  /** The floor the last ack kept from (the daemon keeps lines from it on for a later attach). */
  private keptFrom: number | null = null
  /** A forced ack released lines through here; a floor at or below it was already given up. */
  private releasedThrough = 0
  /**
   * The daemon's ask covers through here. A first answer can fall short (lines still on their way),
   * and the daemon won't ask again, so every ack until here saves what it must, as the first did.
   */
  private askedThrough = 0
  /** The floor gave up an open item; held until an ack carrying the cut succeeds. */
  private pendingCut = false
  /** Requests already handed on, so a replay or reattach never asks the user twice. */
  private readonly deliveredPending = new Set<number>()
  private preambleArrived: (() => void) | null = null
  private held: { seq: number | null; line: string }[] | null
  /** How far a held replay has been handed on; it stays held until the slices reach the end. */
  private releasedTo = 0
  private releasing: Promise<void> | null = null
  /** Set when a replay may start inside an open item: items cut by that move to continuation rows. */
  private continuation: RelayedProviderContinuation | null = null
  private readonly consumption = new RelayedProviderConsumption(() => {
    if (this.consumption.upTo(this.pushedSeq) > this.ackedSeq) {
      this.scheduleAck()
    }
  })
  /** The hook the stream's record reader calls (`claim`, then `taken` per record). */
  readonly recordTaking = this.consumption.taking
  private cancelAck: (() => void) | null = null
  private acking: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: OutputOptions) {
    this.held = options.passWhileHeld ? [] : null
    options.ackFloor?.wake?.(() => this.scheduleAck())
  }

  /** Where the next attach starts: lines held but never handed on come again. */
  restartAt(fromSeq?: number): number {
    if (fromSeq !== undefined) {
      this.pushedSeq = fromSeq
      this.ackedSeq = fromSeq
      this.keptFrom = null
      this.releasedThrough = fromSeq
      this.consumption.reset(fromSeq)
    }
    if (this.held) {
      this.held = []
      this.releasedTo = 0
    }
    this.kept.lines.clear()
    this.deliveredSeq = this.pushedSeq
    return this.pushedSeq
  }

  line(event: RelayProtocol.ProviderRelayDataEvent['event'], seq: number, line: string): void {
    if (this.stopped) {
      return
    }
    if (event === 'relayInitialize') {
      this.initializeLine = line
      this.preambleArrived?.()
      return
    }
    // A fresh spawn's re-sent kept lines after a dropped stream are never read, so never held.
    if (event === 'relayKept') {
      return void (this.kept.take(this.held !== null, seq, line) && this.preambleArrived?.())
    }
    if (event === 'relayPending') {
      if (!this.deliveredPending.has(seq)) {
        this.deliveredPending.add(seq)
        this.deliver(null, line)
      }
      this.preambleArrived?.()
      return
    }
    if (seq <= this.deliveredSeq) {
      return
    }
    this.deliver(seq, this.deliveredPending.has(seq) ? null : line)
  }

  /**
   * The attach reply comes on the control socket and its preamble (the initialize answer, held
   * requests and kept lines) on the stream socket, and nothing orders the two: resolves once the preamble the
   * reply names is here, or after `timeoutMs` (a stream that dropped reattaches anyway). `kept`:
   * the attach asked for kept lines, so it waits for those it names too.
   */
  awaitPreamble(attach: RelayProtocol.ProviderRelayAttachResult, timeoutMs: number, kept = false) {
    const { initializeResultSent: initialize, pending: pendingSeqs } = attach
    const keptSeqs = kept ? (attach.kept ?? []).map((line) => line.seq) : []
    const here = (): boolean =>
      (!initialize || this.initializeLine !== null) &&
      pendingSeqs.every((seq) => this.deliveredPending.has(seq)) &&
      keptSeqs.every((seq) => this.kept.lines.has(seq))
    if (here()) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.preambleArrived = null
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      this.preambleArrived = () => void (here() && done())
    })
  }

  /** The replay may start inside an open item; set before release. */
  continueWith(continuation: RelayedProviderContinuation | null): void {
    this.continuation = continuation
  }

  /** Output waits for the chat to be ready (`release()`). */
  get holding(): boolean {
    return this.held !== null
  }

  /** Hands held output on in order, in slices; settles once nothing is held. */
  release(): Promise<void> {
    if (!this.held) {
      return Promise.resolve()
    }
    this.releasing ??= new Promise<void>((resolve) => {
      const slice = () => {
        const held = this.held ?? []
        let chars = 0
        while (this.releasedTo < held.length) {
          const entry = held[this.releasedTo++]!
          this.push(entry.seq, entry.line)
          chars += entry.line.length + 1
          if (chars >= RELEASE_SLICE_CHARS && this.releasedTo < held.length) {
            setImmediate(slice)
            return
          }
        }
        this.held = null
        this.releasedTo = 0
        this.releasing = null
        resolve()
      }
      slice()
    })
    return this.releasing
  }

  /** Acks everything handed on now, after its durability barrier; `force` saves live text first. */
  settle(force = false, askedThrough = 0): Promise<void> {
    this.askedThrough = Math.max(this.askedThrough, force ? askedThrough : 0)
    this.clearAckTimer()
    return this.ack(force)
  }

  /** Before a hand-off: streamed text is saved first, so the last ack covers every line handed on
   *  (a cut item isn't kept whole, so a replay of a line the journal holds would show it twice). */
  async flush(waitMs = relayHandOffWaitMs()): Promise<void> {
    // A reader paused by its sink takes its buffered lines once that drains; they count too.
    await this.allTaken(waitMs)
    this.askedThrough = Math.max(this.askedThrough, this.deliveredSeq)
    this.clearAckTimer()
    await this.ack(false)
    // A release that ack learned of is recorded now (lines since are saved first): acks stop next.
    this.askedThrough = Math.max(this.askedThrough, this.deliveredSeq)
    return this.pendingCut ? this.ack(false) : undefined
  }

  /** Settles once the stream's reader took every line handed on, or after `waitMs` regardless. */
  allTaken(waitMs: number): Promise<void> {
    return withTimeout(this.consumption.allTaken(), waitMs, undefined)
  }

  /** No more acks: the relay was handed off. */
  stop(): void {
    this.stopped = true
    this.clearAckTimer()
  }

  /** `seq` null is a held request (not a spool position); `line` null only advances the cursor. */
  private deliver(seq: number | null, line: string | null): void {
    if (seq !== null) {
      this.deliveredSeq = Math.max(this.deliveredSeq, seq)
    }
    if (!this.held) {
      this.push(seq, line)
      return
    }
    if (line !== null && this.options.passWhileHeld?.(line)) {
      // Handed on now, but the cursor waits behind the held lines before it.
      this.push(null, line)
      this.held.push({ seq, line: '' })
    } else {
      this.held.push({ seq, line: line ?? '' })
    }
  }

  private push(seq: number | null, given: string | null): void {
    let line = given
    // The floor reads each line as it is handed on: acks only ever cover what was.
    if (line && seq !== null) {
      const lines = this.continuation?.lines(seq, line, this.options.ackFloor) ?? [line]
      if (this.continuation?.done) {
        this.continuation = null
      }
      line = lines.pop() ?? line
      // Lines a continuation adds before this one go out ahead of it, under its seq.
      for (const added of lines) {
        this.options.ackFloor?.observe(seq, added)
        // Counted before it is handed on: a flowing reader takes it inside push.
        this.consumption.pushed(true, this.pushedSeq)
        this.options.stdout.push(`${added}\n`)
      }
      this.options.ackFloor?.observe(seq, line)
    }
    if (seq !== null && seq > this.pushedSeq) {
      this.pushedSeq = seq
      this.scheduleAck()
    }
    // The reader makes no record of a blank line, so it counts as the cursor alone.
    this.consumption.pushed(line !== null && /\S/.test(line), this.pushedSeq)
    if (line) {
      this.options.stdout.push(`${line}\n`)
    }
  }

  /** The first spool line still held, not yet handed on to the chat. */
  private heldFrom(): number | null {
    const held = this.held ?? []
    for (let at = this.releasedTo; at < held.length; at++) {
      const { seq } = held[at]!
      if (seq !== null && seq > this.releasedThrough) {
        return seq
      }
    }
    return null
  }

  private scheduleAck(): void {
    if (this.cancelAck || this.stopped) {
      return
    }
    const run = () => {
      this.cancelAck = null
      void this.ack()
    }
    this.cancelAck = this.options.scheduleAck?.(run) ?? ownAckTimer(run)
  }

  private clearAckTimer(): void {
    this.cancelAck?.()
    this.cancelAck = null
  }

  private ack(force = false): Promise<void> {
    this.acking = this.acking.then(async () => {
      // Only what the chat's reader took: a paused reader's lines are replayed after a crash.
      // Held for an opening chat, lines are received but not taken; the open waits on the agent,
      // which the daemon pauses at its cap until an ack, so its ask is answered by keeping them.
      const heldFrom = force ? this.heldFrom() : null
      const target = Math.max(
        this.consumption.upTo(this.pushedSeq),
        heldFrom === null ? 0 : this.deliveredSeq
      )
      // Lines from the floor on (a streamed item still open) stay kept, so a reattach rewrites the
      // item whole. The daemon's ask while keeping (its file cap) releases them, and the forced
      // save keeps the text; an ask before any keep (its memory cap) starts keeping instead.
      const floor = this.options.ackFloor?.floor(target, this.releasedThrough) ?? null
      const usable = floor !== null && floor > this.releasedThrough && floor <= target
      const keepAt = usable ? Math.min(floor, heldFrom ?? floor) : heldFrom
      // Held lines the journal hasn't saved are never let go; the daemon spools them instead.
      const releasing = force && this.keptFrom !== null && heldFrom === null
      const keepFrom = keepAt !== null && !releasing ? keepAt : null
      if (
        (target <= this.ackedSeq && keepFrom === this.keptFrom && !this.pendingCut) ||
        this.stopped
      ) {
        return
      }
      // Wait one turn so records just parsed reach the journal before its barrier is taken.
      await new Promise((resolve) => setImmediate(resolve))
      try {
        // Unsaved streamed text is only in a kept item, which a reattach replays whole.
        const owed = force || this.ackedSeq < this.askedThrough
        if ((await this.options.durable?.(owed)) === false && keepFrom === null) {
          return
        }
        // Giving up an open kept span: the next attach must know its replay starts inside an item.
        this.pendingCut ||= this.options.ackFloor?.tookCut?.() === true
        const cut = this.pendingCut || (force && keepFrom === null && this.keptFrom !== null)
        // Named on each try: a retry after a failed ack may carry a different cut.
        const cutKeys = cut
          ? boundedCutKeys(this.options.ackFloor, keepFrom === null ? target : undefined)
          : null
        const flags = {
          ...(cut ? { cut: true as const } : {}),
          ...(heldFrom !== null ? { held: true as const } : {}),
          ...(cutKeys ? { cutKeys } : {})
        }
        const reply = await (keepFrom === null && !cut
          ? this.options.ack(target)
          : this.options.ack(target, keepFrom ?? undefined, flags))
        this.ackedSeq = Math.max(this.ackedSeq, target)
        this.pendingCut = false
        this.keptFrom = keepFrom
        if (force && keepFrom === null) {
          this.releasedThrough = Math.max(this.releasedThrough, target)
          this.options.ackFloor?.released?.(target)
        }
        // The daemon let kept lines go at a cap: they are given up, as a cut it records.
        const acked = seqOf(jsonProperty(reply, 'ackedThrough'))
        const truncated = seqOf(jsonProperty(reply, 'truncatedThrough'))
        const released = Math.max(keepFrom !== null && acked >= keepFrom ? acked : 0, truncated)
        if (released > this.releasedThrough) {
          // keptFrom stays: the daemon still keeps, so the next ack without a floor must reach it.
          this.releasedThrough = released
          this.options.ackFloor?.released?.(released)
          // The next ack records it as a cut naming exactly what it split, maybe nothing.
          this.pendingCut = true
          this.scheduleAck()
        }
      } catch {
        // Unacked output is replayed on the next attach; a later ack covers it.
      }
    })
    return this.acking
  }
}

function ownAckTimer(run: () => void): () => void {
  const timer = setTimeout(run, ACK_DELAY_MS)
  timer.unref?.()
  return () => clearTimeout(timer)
}
