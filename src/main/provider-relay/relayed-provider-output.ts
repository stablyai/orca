import type { Readable } from 'node:stream'
import type { ProviderRelayDataEvent } from '../daemon/protocol/daemon-provider-relay-protocol'

/** Acks batch this long after output; the daemon asks sooner (relayAckWanted) when it holds a lot. */
const ACK_DELAY_MS = 1_000

type OutputOptions = {
  stdout: Readable
  /** Holds output until `release()`, except the lines this lets through (answers to new requests). */
  passWhileHeld?: (line: string) => boolean
  /** Resolves once everything handed on is durable; a rejection leaves the output unacked. */
  durable?: () => Promise<void>
  ack: (seq: number) => Promise<unknown>
}

/**
 * A relay's output cursor: lines in seq order onto stdout, each request once, and acks that only
 * cover what the consumer was handed and the journal holds.
 */
export class RelayedProviderOutput {
  /** The agent's answer to the first client's `initialize`, when the relay was reattached. */
  initializeLine: string | null = null
  /** Highest data seq handed on or held; spool lines at or below it are already seen. */
  private deliveredSeq = 0
  /** Highest data seq actually handed on; the next attach and every ack start here. */
  private pushedSeq = 0
  private ackedSeq = 0
  /** Requests already handed on, so a replay or reattach never asks the user twice. */
  private readonly deliveredPending = new Set<number>()
  private held: { seq: number | null; line: string }[] | null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private acking: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: OutputOptions) {
    this.held = options.passWhileHeld ? [] : null
  }

  /** Where the next attach starts: lines held but never handed on come again. */
  restartAt(fromSeq?: number): number {
    if (fromSeq !== undefined) {
      this.pushedSeq = fromSeq
      this.ackedSeq = fromSeq
    }
    if (this.held) {
      this.held = []
    }
    this.deliveredSeq = this.pushedSeq
    return this.pushedSeq
  }

  line(event: ProviderRelayDataEvent['event'], seq: number, line: string): void {
    if (this.stopped) {
      return
    }
    if (event === 'relayInitialize') {
      this.initializeLine = line
      return
    }
    if (event === 'relayPending') {
      if (!this.deliveredPending.has(seq)) {
        this.deliveredPending.add(seq)
        this.deliver(null, line)
      }
      return
    }
    if (seq <= this.deliveredSeq) {
      return
    }
    this.deliver(seq, this.deliveredPending.has(seq) ? null : line)
  }

  release(): void {
    const held = this.held
    this.held = null
    for (const entry of held ?? []) {
      this.push(entry.seq, entry.line)
    }
  }

  /** Acks everything handed on now, after its durability barrier. */
  settle(): Promise<void> {
    this.clearAckTimer()
    return this.ack()
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

  private push(seq: number | null, line: string | null): void {
    if (line) {
      this.options.stdout.push(`${line}\n`)
    }
    if (seq !== null && seq > this.pushedSeq) {
      this.pushedSeq = seq
      this.scheduleAck()
    }
  }

  private scheduleAck(): void {
    if (this.ackTimer || this.stopped) {
      return
    }
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      void this.ack()
    }, ACK_DELAY_MS)
    this.ackTimer.unref?.()
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }

  private ack(): Promise<void> {
    this.acking = this.acking.then(async () => {
      const target = this.pushedSeq
      if (target <= this.ackedSeq || this.stopped) {
        return
      }
      // Wait one turn so records just parsed reach the journal before its barrier is taken.
      await new Promise((resolve) => setImmediate(resolve))
      try {
        await this.options.durable?.()
        await this.options.ack(target)
        this.ackedSeq = Math.max(this.ackedSeq, target)
      } catch {
        // Unacked output is replayed on the next attach; a later ack covers it.
      }
    })
    return this.acking
  }
}
