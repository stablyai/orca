import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ProviderChild } from '../provider-process/provider-child'
import { notifyProviderChild } from '../provider-process/provider-child'
import type {
  ProviderRelayAttachResult,
  ProviderRelayDetachPolicy,
  ProviderRelayExit
} from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayChannel } from './provider-relay-channel'
import { RelayedProviderOutput } from './relayed-provider-output'

/** The daemon refuses input past its queue cap; the write is offered again after this. */
const INPUT_FULL_RETRY_MS = 50
const INPUT_FULL = 'Relay input is full'

type RelayState = 'attaching' | 'attached' | 'reattaching' | 'detached' | 'exited'

export type RelayedProviderChildOptions = {
  channel: ProviderRelayChannel
  relayId: string
  pid: number
  /** Read at each attach and detach, so a settings change applies to the next one. */
  policy: () => ProviderRelayDetachPolicy
  /** During quit a dropped stream is the hand-off itself, not a fault to recover from. */
  quitting?: () => boolean
  /** Resolves once everything the consumer was handed is durable; acks wait for it. */
  durable?: () => Promise<void>
  /** Holds output until `releaseOutput()`, except the lines this lets through (answers to new requests). */
  passWhileHeld?: (line: string) => boolean
}

/**
 * An agent the terminal daemon owns, seen through the relay as a child process: stdout is the
 * agent's lines in seq order (unanswered requests first), stdin goes out as `relayWrite`s.
 */
export class RelayedProviderChild extends EventEmitter implements ProviderChild {
  readonly pid: number
  readonly stdout = new Readable({ read() {} })
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
  private state: RelayState = 'attaching'
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
      ack: (seq) => options.channel.ack(options.relayId, seq),
      ...(options.durable ? { durable: options.durable } : {}),
      ...(options.passWhileHeld ? { passWhileHeld: options.passWhileHeld } : {})
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

  get handedOff(): boolean {
    return this.state === 'detached'
  }

  /** Attaches from `fromSeq`; the spool after it and unanswered requests then arrive as stdout. */
  async start(fromSeq: number): Promise<ProviderRelayAttachResult> {
    this.output.restartAt(fromSeq)
    this.unbind = this.options.channel.bind(this.relayId, {
      line: (event, seq, line) => this.output.line(event, seq, line),
      exit: (exit) => this.onExit(exit),
      disconnected: () => void this.reattach()
    })
    try {
      const result = await this.options.channel.attach(this.relayId, fromSeq, this.options.policy())
      this.attachResult = result
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
    this.output.release()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
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
    if (this.state === 'exited' || this.state === 'detached') {
      return Promise.resolve()
    }
    return this.options.channel
      .close(this.relayId, grace)
      .then(() => {})
      .catch(() => {})
  }

  /** Everything handed on is durable and acked, so a later attach replays nothing twice. */
  async settle(): Promise<void> {
    await this.writing
    await this.output.settle()
  }

  /** The agent keeps running under the daemon; this app stops seeing it. */
  async detach(policy: ProviderRelayDetachPolicy): Promise<void> {
    if (this.state === 'exited' || this.state === 'detached') {
      return
    }
    await this.settle()
    this.state = 'detached'
    this.output.stop()
    this.unbind?.()
    this.unbind = null
    await this.options.channel.detach(this.relayId, policy)
  }

  private input(chunks: unknown[], callback: (error?: Error | null) => void): void {
    const data = chunks
      .map((chunk) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString()))
      .join('')
    const sent = this.writing.then(() => this.send(data))
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
    // Held output still goes out first: the consumer must see what the agent said before it ended.
    this.releaseOutput()
    this.state = 'exited'
    this.exitStatus = exit
    this.exitCode = exit.code
    this.signalCode = (exit.signal as NodeJS.Signals | null) ?? null
    if (lost) {
      this.outcomeLost = true
    }
    // The final output is acked so the daemon can drop the ended relay.
    void this.output.settle().finally(() => {
      this.output.stop()
      this.unbind?.()
      this.unbind = null
    })
    if (exit.stderrTail) {
      this.stderr.push(exit.stderrTail)
    }
    this.stderr.push(null)
    this.stdout.push(null)
    this.stdin.destroy()
    // A turn later, so a flowing reader gets the last output before it hears of the exit.
    setImmediate(() => {
      notifyProviderChild(this, 'exit', exit.code, this.signalCode)
      setImmediate(() => notifyProviderChild(this, 'close', exit.code, this.signalCode))
    })
  }
}
