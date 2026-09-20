import { existsSync } from 'node:fs'
import type { Socket } from 'node:net'
import type { PairingTunnel } from '../../shared/mobile-relay-pairing-offer'
import { runProcess, spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { connectThroughSocks5 } from './socks5-connect'
import { tailcatKeyPathArgument } from './tailcat-binary'
import { guardChildStreams, terminateChild, type TailcatChild } from './tailcat-child-lifecycle'
import { onProcessOutputLines } from './tailcat-process-output'
import { dialTailcatSocks, type RunningTailcatSocksProxy } from './tailcat-socks-dial'

export type TailcatProcessSpawner = (spec: ProcessSpec) => ReturnType<typeof spawnProcess>
export type TailcatProcessRunner = (spec: ProcessSpec) => ReturnType<typeof runProcess>

export type TailcatSocksProxyOptions = {
  binary: string
  /** Persistent client identity, so a host can later restrict its tunnel to known clients. */
  keyPath: string
  spawn?: TailcatProcessSpawner
  run?: TailcatProcessRunner
  logf?: (message: string) => void
  startTimeoutMs?: number
  terminateGraceMs?: number
  connect?: typeof connectThroughSocks5
  dialRetryDelayMs?: number
  recoveryCooldownMs?: number
  now?: () => number
}

const SOCKS_LISTEN_PATTERN = /socks5h:\/\/127\.0\.0\.1:(\d+)/
const DEFAULT_START_TIMEOUT_MS = 20_000
const KEYGEN_TIMEOUT_MS = 30_000
const DEFAULT_RECOVERY_COOLDOWN_MS = 30_000

/**
 * One `tailcat socks` child per Orca process. Destinations are address blobs, so a single proxy
 * reaches every tunnel-shared server without the blob ever appearing in the process table.
 */
export class TailcatSocksProxy {
  private child: TailcatChild | null = null
  private port: number | null = null
  private generation = 0
  private starting: Promise<RunningTailcatSocksProxy> | null = null
  private startingAbort: AbortController | null = null
  private recovery: { generation: number; promise: Promise<boolean> } | null = null
  private readonly pendingDials = new Map<number, number>()
  private readonly activeStreams = new Map<number, number>()
  private readonly pendingNegotiations = new Set<AbortController>()
  private lastRecoveryAt = Number.NEGATIVE_INFINITY
  private stopped = false

  constructor(private readonly options: TailcatSocksProxyOptions) {}

  async dial(tunnel: PairingTunnel, signal?: AbortSignal): Promise<Socket> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      controller.abort()
    }
    this.pendingNegotiations.add(controller)
    try {
      return await dialTailcatSocks({
        tunnel,
        signal: controller.signal,
        connect: this.options.connect ?? connectThroughSocks5,
        currentRecovery: () => this.recovery?.promise ?? null,
        ensureStarted: () => this.ensureStarted(),
        beginAttempt: (generation) => this.increment(this.pendingDials, generation),
        endAttempt: (generation) => this.decrement(this.pendingDials, generation),
        acceptSocket: (socket, proxy) => this.acceptSocket(socket, proxy),
        recoverIdleProxy: (generation) => this.recoverIdleProxy(generation),
        isStopped: () => this.stopped,
        retryDelayMs: this.options.dialRetryDelayMs,
        logf: this.options.logf
      })
    } catch (error) {
      if (this.stopped) {
        throw new Error('Tailcat proxy has been stopped')
      }
      throw error
    } finally {
      this.pendingNegotiations.delete(controller)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  getPort(): number | null {
    return this.port
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    for (const controller of this.pendingNegotiations) {
      controller.abort()
    }
    const child = this.child
    const starting = this.starting
    const recovery = this.recovery?.promise
    this.startingAbort?.abort()
    this.child = null
    this.port = null
    await Promise.all([
      child ? terminateChild(child, this.options.terminateGraceMs) : Promise.resolve(),
      starting?.catch(() => {}) ?? Promise.resolve(),
      recovery?.catch(() => {}) ?? Promise.resolve()
    ])
  }

  private ensureStarted(): Promise<RunningTailcatSocksProxy> {
    if (this.port !== null) {
      return Promise.resolve({ generation: this.generation, port: this.port })
    }
    if (!this.starting) {
      const controller = new AbortController()
      this.startingAbort = controller
      const starting = this.start(controller.signal).finally(() => {
        if (this.starting === starting) {
          this.starting = null
        }
      })
      this.starting = starting
    }
    return this.starting
  }

  private async start(signal: AbortSignal): Promise<RunningTailcatSocksProxy> {
    this.assertNotStopped()
    await this.ensureClientKey(signal)
    // Why: a stop that landed during key generation must not leave an unowned proxy behind.
    this.assertNotStopped()
    const spawn = this.options.spawn ?? spawnProcess
    const child = spawn({
      program: this.options.binary,
      args: [
        `--key=${tailcatKeyPathArgument(this.options.keyPath)}`,
        'socks',
        '--listen=127.0.0.1:0'
      ],
      timeoutMs: null
    })
    const generation = ++this.generation
    guardChildStreams(child, this.options.logf)
    this.child = child
    child.stdout.resume()
    return new Promise<RunningTailcatSocksProxy>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(new Error('Timed out waiting for tailcat socks to start'))
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      const detachLines = onProcessOutputLines(child.stderr, (line) => {
        this.options.logf?.(`[tailcat socks] ${line}`)
        const match = SOCKS_LISTEN_PATTERN.exec(line)
        if (match) {
          finish(null, Number(match[1]))
        }
      })
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child === child && this.generation === generation) {
          this.child = null
          this.port = null
        }
        finish(new Error(`tailcat socks exited (${signal ?? code ?? 'unknown'})`))
      }
      const onError = (error: Error): void => finish(error)
      const finish = (error: Error | null, port?: number): void => {
        clearTimeout(timeout)
        detachLines()
        child.off('error', onError)
        if (error) {
          child.off('exit', onExit)
          if (this.child === child) {
            this.child = null
          }
          void terminateChild(child, this.options.terminateGraceMs)
          reject(error)
          return
        }
        if (this.child !== child || this.generation !== generation || this.stopped) {
          reject(new Error('Tailcat proxy has been stopped'))
          return
        }
        this.port = port!
        resolve({ generation, port: port! })
      }
      // Why: the exit listener outlives startup so a crashed proxy is respawned on the next dial.
      child.on('exit', onExit)
      child.on('error', onError)
    })
  }

  private recoverIdleProxy(generation: number): Promise<boolean> {
    if (generation !== this.generation) {
      return Promise.resolve(true)
    }
    if (this.recovery) {
      return this.recovery.promise.then((replaced) => replaced || generation !== this.generation)
    }
    const promise = Promise.resolve().then(() => this.replaceIdleProxy(generation))
    this.recovery = { generation, promise }
    const clearRecovery = (): void => {
      if (this.recovery?.promise === promise) {
        this.recovery = null
      }
    }
    void promise.then(clearRecovery, clearRecovery)
    return promise
  }

  private async replaceIdleProxy(generation: number): Promise<boolean> {
    if (generation !== this.generation) {
      return true
    }
    const now = (this.options.now ?? Date.now)()
    if (
      now - this.lastRecoveryAt <
      (this.options.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS)
    ) {
      return false
    }
    if (
      (this.pendingDials.get(generation) ?? 0) > 0 ||
      (this.activeStreams.get(generation) ?? 0) > 0
    ) {
      return false
    }
    const child = this.child
    this.child = null
    this.port = null
    this.generation += 1
    this.lastRecoveryAt = now
    this.options.logf?.(`[tailcat socks] replacing idle proxy generation ${generation}`)
    if (child) {
      await terminateChild(child, this.options.terminateGraceMs)
    }
    this.assertNotStopped()
    await this.ensureStarted()
    return true
  }

  private acceptSocket(socket: Socket, proxy: RunningTailcatSocksProxy): void {
    if (this.stopped || proxy.generation !== this.generation || proxy.port !== this.port) {
      socket.destroy()
      throw new Error(
        this.stopped ? 'Tailcat proxy has been stopped' : 'Tailcat proxy generation changed'
      )
    }
    this.trackStream(socket, proxy.generation)
  }

  private trackStream(socket: Socket, generation: number): void {
    if (socket.destroyed) {
      return
    }
    this.increment(this.activeStreams, generation)
    socket.once('close', () => this.decrement(this.activeStreams, generation))
  }

  private increment(counts: Map<number, number>, generation: number): void {
    counts.set(generation, (counts.get(generation) ?? 0) + 1)
  }

  private decrement(counts: Map<number, number>, generation: number): void {
    const next = (counts.get(generation) ?? 1) - 1
    if (next === 0) {
      counts.delete(generation)
    } else {
      counts.set(generation, next)
    }
  }

  private assertNotStopped(): void {
    if (this.stopped) {
      throw new Error('Tailcat proxy has been stopped')
    }
  }

  private async ensureClientKey(signal: AbortSignal): Promise<void> {
    if (existsSync(this.options.keyPath)) {
      return
    }
    const run = this.options.run ?? runProcess
    const result = await run({
      program: this.options.binary,
      args: ['genkey', '--client', `--key=${tailcatKeyPathArgument(this.options.keyPath)}`],
      timeoutMs: KEYGEN_TIMEOUT_MS,
      signal
    })
    if (result.code !== 0 && !signal.aborted) {
      throw new Error(`tailcat genkey --client failed: ${result.stderr.trim() || result.code}`)
    }
  }
}
