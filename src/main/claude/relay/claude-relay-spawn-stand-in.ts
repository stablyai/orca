import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { notifyProviderChild, type ProviderChild } from '../../provider-process/provider-child'

const FORWARDED_EVENTS = ['spawn', 'exit', 'error'] as const

/**
 * What the SDK's synchronous spawn hook returns while the agent starts under the terminal daemon
 * (or, if it can't, directly): input waits in `stdin` and the real child's output flows through.
 */
export class ClaudeRelaySpawnStandIn extends EventEmitter implements ProviderChild {
  readonly stdin = new PassThrough()
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
    this.stdin.pipe(real.stdin)
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
      (error: unknown) => this.settleReady(error instanceof Error ? error : new Error(String(error)))
    )
    if (this.pendingKill !== null) {
      real.kill(this.pendingKill)
    }
  }

  /** The launch threw before any child existed. */
  fail(error: Error): void {
    this.settleReady(error)
    notifyProviderChild(this, 'error', error)
    this.stdout.end()
    this.stderr.end()
    notifyProviderChild(this, 'close', null, null)
  }
}
