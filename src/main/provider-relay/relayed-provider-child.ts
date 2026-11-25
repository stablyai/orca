import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ProviderChild } from '../provider-process/provider-child'
import { isProviderExitSignal, notifyProviderChild } from '../provider-process/provider-child'
import type {
  ProviderRelayAttachResult,
  ProviderRelayDetachPolicy,
  ProviderRelayExit
} from '../daemon/protocol/daemon-provider-relay-protocol'
import { RELAY_WRITE_CHUNK_CHARS } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayChannel } from './provider-relay-channel'
import { RelayedProviderOutput, type ProviderRelayAckFloor } from './relayed-provider-output'
import type { ProviderRelayRecordTaking } from './relayed-provider-consumption'
import {
  attachContinuation,
  type ProviderRelayItemContinuation
} from './relayed-provider-continuation'

/** The daemon refuses input past its queue cap; the write is offered again after this. */
const INPUT_FULL_RETRY_MS = 50
const INPUT_FULL = 'Relay input is full'

/** How long an attach waits for its preamble's stream events after the reply. */
const PREAMBLE_WAIT_MS = 10_000
/** A reader paused this long past an exit (a stuck journal drain) no longer holds the exit back. */
const EXIT_AFTER_OUTPUT_WAIT_MS = 10_000

type RelayState = 'attaching' | 'attached' | 'reattaching' | 'detached' | 'exited'

export type RelayedProviderChildOptions = {
  channel: ProviderRelayChannel
  relayId: string
  pid: number
  /** Read at each attach and detach, so a settings change applies to the next one. */
  policy: () => ProviderRelayDetachPolicy
  /** During quit a dropped stream is the hand-off itself, not a fault to recover from. */
  quitting?: () => boolean
  /** Acks wait for it; false (streamed text not saved yet) skips the ack unless `force` saved it. */
  durable?: (force: boolean) => Promise<boolean>
  /** Holds output until `releaseOutput()`, except the lines this lets through (answers to new requests). */
  passWhileHeld?: (line: string) => boolean
  ackFloor?: ProviderRelayAckFloor
  /** Re-keys items a cap-cut replay starts inside, so they never overwrite their saved rows. */
  continuation?: ProviderRelayItemContinuation
}

/**
 * An agent the terminal daemon owns, seen through the relay as a child process: stdout is the
 * agent's lines in seq order (unanswered requests first), stdin goes out as `relayWrite`s.
 */
export class RelayedProviderChild extends EventEmitter implements ProviderChild {
  readonly pid: number
  readonly stdout: Readable & { relayRecords: ProviderRelayRecordTaking } = Object.assign(
    new Readable({ read() {} }),
    {
      relayRecords: {
        claim: () => this.output.recordTaking.claim(),
        taken: () => this.output.recordTaking.taken(),
        uncounted: () => this.output.recordTaking.uncounted()
      }
    }
  )
  readonly stderr = new Readable({ read() {} })
  readonly stdin: Writable
  readonly ready: Promise<void>
  connected = false
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  outcomeLost?: boolean
  /** What the first attach reported: request id floor, cached initialize answer, stderr, exit. */
  attachResult: ProviderRelayAttachResult | null = null
  /** The cursor this child last attached from. */
  attachedFrom = 0
  private state: RelayState = 'attaching'
  /** An end that came while output was held; it runs once the output is released. */
  private parkedEnd: { exit: ProviderRelayExit; lost: boolean } | null = null
  private exitStatus: ProviderRelayExit | null = null
  private unbind: (() => void) | null = null
  private readonly output: RelayedProviderOutput
  /** Settles once a dropped stream is attached again (or given up), so input waits for it. */
  private reattached: Promise<void> = Promise.resolve()
  private writing: Promise<void> = Promise.resolve()
  private readonly options: RelayedProviderChildOptions
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(options: RelayedProviderChildOptions) {
    super()
    this.options = options
    this.pid = options.pid
    this.output = new RelayedProviderOutput({
      stdout: this.stdout,
      ack: (seq, keepFrom, flags) => options.channel.ack(options.relayId, seq, keepFrom, flags),
      ...(options.durable ? { durable: options.durable } : {}),
      ...(options.passWhileHeld ? { passWhileHeld: options.passWhileHeld } : {}),
      ...(options.ackFloor ? { ackFloor: options.ackFloor } : {})
    })
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // A failed attach is reported through `exit`; `ready` only says the launch settled.
    this.ready.catch(() => {})
    this.stdin = new Writable({
      decodeStrings: false,
      write: (chunk: unknown, _encoding, callback) => this.input([chunk], callback),
      writev: (chunks, callback) =>
        this.input(
          chunks.map((entry) => entry.chunk),
          callback
        ),
      final: (callback) => {
        // stdin end is the agent's close request, as on a direct launch.
        void this.close().finally(() => callback())
      }
    })
  }

  get relayId(): string {
    return this.options.relayId
  }

  get exited(): ProviderRelayExit | null {
    return this.exitStatus
  }

  /** The agent's answer to the first client's `initialize`, when this relay was reattached. */
  get initializeLine(): string | null {
    return this.output.initializeLine
  }

  /** Lines the daemon kept for this relay, by the seq they were spooled at; names are in `attachResult.kept`. */
  get kept(): Pick<RelayedProviderOutput, 'keptLines' | 'dropKeptLines'> {
    return this.output
  }

  get handedOff(): boolean {
    return this.state === 'detached'
  }

  /** Attaches from `fromSeq`; the spool after it and unanswered requests then arrive as stdout. */
  async start(fromSeq: number): Promise<ProviderRelayAttachResult> {
    this.output.restartAt((this.attachedFrom = fromSeq))
    this.unbind = this.options.channel.bind(this.relayId, {
      line: (event, seq, line) => this.output.line(event, seq, line),
      ackWanted: (seq) => void this.output.settle(true, seq),
      exit: (exit) => this.onExit(exit),
      disconnected: () => void this.reattach()
    })
    try {
      const { channel } = this.options
      const kept = this.output.wantsKeptLines
      const result = await channel.attach(this.relayId, fromSeq, this.options.policy(), kept)
      const keptSeqs = kept ? (result.kept ?? []).map((line) => line.seq) : []
      await this.output.awaitPreamble(result, PREAMBLE_WAIT_MS, keptSeqs)
      this.attachResult = result
      const { continuation } = this.options
      if (continuation) {
        this.output.continueWith(attachContinuation(continuation, this.relayId, fromSeq, result))
      }
      if (this.state === 'attaching') {
        this.state = 'attached'
      }
      this.resolveReady()
      return result
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.rejectReady(failure)
      this.end({ code: null, signal: null }, true)
      throw failure
    }
  }

  /** Lets held output through, in order, once the consumer can route it. */
  releaseOutput(): void {
    void this.output.release().then(() => {
      const parked = this.parkedEnd
      this.parkedEnd = null
      if (parked) {
        this.end(parked.exit, parked.lost)
      }
    })
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    // A chat that gives up before it was ready still hears the agent's end, after its output.
    this.releaseOutput()
    if (this.state === 'exited' || this.state === 'detached') {
      return false
    }
    this.killed = true
    void this.options.channel
      .close(this.relayId, signal === 'SIGKILL' ? 'brief' : undefined)
      .catch(() => {})
    return true
  }

  close(grace?: 'brief'): Promise<void> {
    this.releaseOutput()
    if (this.state === 'exited' || this.state === 'detached') {
      return Promise.resolve()
    }
    return this.options.channel
      .close(this.relayId, grace)
      .then(() => {})
      .catch(() => {})
  }

  /** Everything handed on is durable and acked, so a later attach replays nothing twice. */
  async settle(handingOff = false): Promise<void> {
    await this.writing
    await (handingOff ? this.output.flush(EXIT_AFTER_OUTPUT_WAIT_MS) : this.output.settle())
  }

  /** The agent keeps running under the daemon; this app stops seeing it. */
  async detach(policy: ProviderRelayDetachPolicy): Promise<void> {
    if (this.state === 'exited' || this.state === 'detached') {
      return
    }
    // Nothing more is read first: a line read during the last ack would be saved but not acked.
    this.unbind?.()
    this.unbind = null
    await this.settle(true)
    this.state = 'detached'
    this.output.stop()
    await this.options.channel.detach(this.relayId, policy)
  }

  private input(chunks: unknown[], callback: (error?: Error | null) => void): void {
    const data = chunks
      .map((chunk) => (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)))
      .join('')
    // The daemon joins a surrogate pair split between writes, so a plain slice is safe.
    const sent = this.writing.then(async () => {
      for (let at = 0; at < data.length; at += RELAY_WRITE_CHUNK_CHARS) {
        await this.send(data.slice(at, at + RELAY_WRITE_CHUNK_CHARS))
      }
    })
    this.writing = sent.then(
      () => {},
      () => {}
    )
    sent.then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)))
    )
  }

  private async send(data: string): Promise<void> {
    for (;;) {
      if (this.state === 'detached') {
        return
      }
      if (this.state === 'exited') {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      }
      try {
        await this.options.channel.write(this.relayId, data)
        return
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(INPUT_FULL)) {
          if (this.state === 'reattaching' || this.state === 'attaching') {
            await Promise.all([this.ready.catch(() => {}), this.reattached])
            continue
          }
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, INPUT_FULL_RETRY_MS))
      }
    }
  }

  /** The daemon detached us when the stream dropped; the same daemon resumes from our cursor. */
  private async reattach(): Promise<void> {
    if (this.state !== 'attached') {
      return
    }
    if (this.options.quitting?.()) {
      this.state = 'detached'
      this.output.stop()
      this.unbind?.()
      this.unbind = null
      return
    }
    this.state = 'reattaching'
    const daemonPid = this.options.channel.daemonPid
    const done = Promise.withResolvers<void>()
    this.reattached = done.promise
    try {
      await this.options.channel.client.ensureConnected()
      if (this.options.channel.daemonPid !== daemonPid) {
        throw new Error('A different terminal host answered')
      }
      await this.options.channel.attach(
        this.relayId,
        this.output.restartAt(),
        this.options.policy()
      )
      if (this.state === 'reattaching') {
        this.state = 'attached'
      }
    } catch {
      // The host that owned the agent is gone, and the agent with it (its owner pipe closed).
      this.end({ code: null, signal: null }, true)
    } finally {
      done.resolve()
    }
  }

  private onExit(exit: ProviderRelayExit): void {
    this.end(exit, false)
  }

  private end(exit: ProviderRelayExit, lost: boolean): void {
    if (this.state === 'exited' || this.state === 'detached') {
      return
    }
    // Output held for a reattach waits for its chat: the end comes after it, never before the chat exists.
    if (this.output.holding) {
      this.parkedEnd ??= { exit, lost }
      return
    }
    this.state = 'exited'
    this.exitStatus = exit
    this.exitCode = exit.code
    this.signalCode = isProviderExitSignal(exit.signal) ? exit.signal : null
    if (lost) {
      this.outcomeLost = true
    }
    if (exit.stderrTail) {
      this.stderr.push(exit.stderrTail)
    }
    this.stderr.push(null)
    this.stdout.push(null)
    this.stdin.destroy()
    // The chat hears of the exit only after its reader took the last output (a paused reader
    // would otherwise end the turn before its last lines), and then a turn later still.
    const taken = this.output.allTaken(EXIT_AFTER_OUTPUT_WAIT_MS)
    // The final output is acked so the daemon can drop the ended relay.
    void taken
      .then(() => this.output.settle())
      .finally(() => {
        this.output.stop()
        this.unbind?.()
        this.unbind = null
      })
    void taken.then(() =>
      setImmediate(() => {
        notifyProviderChild(this, 'exit', exit.code, this.signalCode)
        setImmediate(() => notifyProviderChild(this, 'close', exit.code, this.signalCode))
      })
    )
  }
}
