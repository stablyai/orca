import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { notifyProviderChild, type ProviderChild } from '../../provider-process/provider-child'

const FORWARDED_EVENTS = ['spawn', 'exit', 'error'] as const

/** Holds writes until the real child exists, then hands each one over with its own callback, so a
 *  write that never reached the agent still fails (a pipe would report it written). */
class StandInInput extends Writable {
  private target: Writable | null = null
  private refused: Error | null = null
  private readonly waiting: (() => void)[] = []

  constructor() {
    super({ decodeStrings: false })
  }

  attach(target: Writable): void {
    this.target = target
    target.on('error', (error) => this.destroy(error))
    this.waiting.splice(0).forEach((run) => run())
  }

  refuse(error: Error): void {
    this.refused = error
    this.waiting.splice(0).forEach((run) => run())
  }

  private whenBound(run: () => void): void {
    if (this.target || this.refused) {
      run()
    } else {
      this.waiting.push(run)
    }
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.whenBound(() =>
      this.target ? this.target.write(chunk, encoding, callback) : callback(this.refused)
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.whenBound(() => (this.target ? this.target.end(() => callback()) : callback()))
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.target?.destroy()
    callback(error)
  }
}

/**
 * What the SDK's synchronous spawn hook returns while the agent starts under the terminal daemon
 * (or, if it can't, directly): input waits in `stdin` and the real child's output flows through.
 */
export class ClaudeRelaySpawnStandIn extends EventEmitter implements ProviderChild {
  readonly stdin = new StandInInput()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly ready: Promise<void>
  private real: ProviderChild | null = null
  private pendingKill: NodeJS.Signals | number | null = null
  private settleReady!: (error?: Error) => void

  constructor() {
    super()
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (error) => (error ? reject(error) : resolve())
    })
    this.ready.catch(() => {})
  }

  get pid(): number | undefined {
    return this.real?.pid
  }

  get connected(): boolean {
    return this.real?.connected ?? false
  }

  get killed(): boolean {
    return this.real?.killed ?? this.pendingKill !== null
  }

  get exitCode(): number | null {
    return this.real?.exitCode ?? null
  }

  get signalCode(): NodeJS.Signals | null {
    return this.real?.signalCode ?? null
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.real) {
      return this.real.kill(signal)
    }
    this.pendingKill = signal ?? 'SIGTERM'
    return true
  }

  bind(real: ProviderChild): void {
    this.real = real
    this.stdin.attach(real.stdin)
    real.stdout.pipe(this.stdout)
    real.stderr.pipe(this.stderr)
    for (const event of FORWARDED_EVENTS) {
      real.on(event, (...args: unknown[]) => notifyProviderChild(this, event, ...args))
    }
    // `close` only after the output passed through, so the reader sees every line first.
    real.once('close', (...args: unknown[]) => {
      void Promise.all([
        finished(this.stdout, { readable: false }).catch(() => {}),
        finished(this.stderr, { readable: false }).catch(() => {})
      ]).then(() => notifyProviderChild(this, 'close', ...args))
    })
    void (real.ready ?? Promise.resolve()).then(
      () => this.settleReady(),
      (error: unknown) =>
        this.settleReady(error instanceof Error ? error : new Error(String(error)))
    )
    if (this.pendingKill !== null) {
      real.kill(this.pendingKill)
    }
  }

  /** The launch threw before any child existed. */
  fail(error: Error): void {
    this.settleReady(error)
    this.stdin.refuse(error)
    notifyProviderChild(this, 'error', error)
    this.stdout.end()
    this.stderr.end()
    notifyProviderChild(this, 'close', null, null)
  }
}
