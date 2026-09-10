import { existsSync } from 'node:fs'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { tailcatKeyPathArgument } from './tailcat-binary'
import { guardChildStreams, terminateChild, type TailcatChild } from './tailcat-child-lifecycle'
import { onProcessOutputLines } from './tailcat-process-output'
import type { TailcatProcessRunner, TailcatProcessSpawner } from './tailcat-socks-proxy'
import type { TailcatTunnelServerState } from '../../shared/tailcat-tunnel-status'

export type { TailcatTunnelServerState }

export type TailcatTunnelServerOptions = {
  binary: string
  /** Persistent server identity: the address blob derives from it, so the pairing link survives restarts. */
  keyPath: string
  spawn?: TailcatProcessSpawner
  run?: TailcatProcessRunner
  logf?: (message: string) => void
  startTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  terminateGraceMs?: number
  onStateChange?: (state: TailcatTunnelServerState) => void
}

const DEFAULT_START_TIMEOUT_MS = 30_000
// Why: `--fixed-region` runs a latency probe against every relay region before it can write the key.
const KEYGEN_TIMEOUT_MS = 60_000
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export class TunnelServerCancelledError extends Error {
  constructor() {
    super('Tailcat tunnel server was stopped')
    this.name = 'TunnelServerCancelledError'
  }
}

/**
 * Supervises `tailcat serve <port>`, which reverse-proxies tunnel connections to the runtime's
 * loopback WebSocket port. The WebSocket listener itself never needs to leave loopback.
 *
 * Desired state is "a server for `port`" until `stop()`. Every launch carries a generation, so a
 * stop or port change during startup cancels that launch instead of racing it, and retries keep
 * going with backoff for as long as the server is still wanted.
 */
export class TailcatTunnelServer {
  private child: TailcatChild | null = null
  private token: string | null = null
  private port: number | null = null
  private state: TailcatTunnelServerState = 'stopped'
  private generation = 0
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempt = 0
  private starting: Promise<string> | null = null

  constructor(private readonly options: TailcatTunnelServerOptions) {}

  getState(): TailcatTunnelServerState {
    return this.state
  }

  getToken(): string | null {
    return this.token
  }

  getPort(): number | null {
    return this.port
  }

  /** Resolves with the address blob once tailcat is listening. Re-entrant while starting. */
  start(port: number): Promise<string> {
    if (this.port === port) {
      if (this.state === 'running' && this.token) {
        return Promise.resolve(this.token)
      }
      if (this.starting) {
        return this.starting
      }
    }
    // Why: a start inside a backoff window must own the relaunch, or two children race for the port.
    this.clearRestartTimer()
    const generation = ++this.generation
    const previous = this.child
    this.child = null
    this.port = port
    this.restartAttempt = 0
    // Why: a port change replaces the child; the old one would otherwise keep serving unsupervised.
    return this.launch(generation, previous)
  }

  async stop(): Promise<void> {
    this.generation += 1
    this.clearRestartTimer()
    const child = this.child
    this.child = null
    this.port = null
    this.setState('stopped')
    if (child) {
      await terminateChild(child, this.options.terminateGraceMs)
    }
  }

  private launch(generation: number, previous: TailcatChild | null = null): Promise<string> {
    const pending = this.launchAttempt(generation, previous).finally(() => {
      if (this.starting === pending) {
        this.starting = null
      }
    })
    this.starting = pending
    return pending
  }

  private async launchAttempt(generation: number, previous: TailcatChild | null): Promise<string> {
    this.setState('starting')
    try {
      if (previous) {
        await terminateChild(previous, this.options.terminateGraceMs)
      }
      await this.ensureServerKey()
      this.assertCurrent(generation)
      const token = await this.spawnServe(generation)
      this.restartAttempt = 0
      this.token = token
      this.setState('running')
      return token
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.scheduleRestart(generation, error)
      }
      throw error
    }
  }

  private spawnServe(generation: number): Promise<string> {
    const port = this.port
    if (port === null) {
      return Promise.reject(new TunnelServerCancelledError())
    }
    const spawn = this.options.spawn ?? spawnProcess
    const child = spawn({
      program: this.options.binary,
      // Why: the short token references a relay region; the expanded form embeds relay nodes,
      // outgrows the SOCKS5 domain-name field, and goes stale when relay nodes rotate.
      args: [
        `--key=${tailcatKeyPathArgument(this.options.keyPath)}`,
        '--json',
        'serve',
        String(port)
      ],
      timeoutMs: null
    })
    guardChildStreams(child, this.options.logf)
    this.child = child
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        settle(new Error('Timed out waiting for tailcat serve to start'))
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      const detachStdout = onProcessOutputLines(child.stdout, (line) => {
        const token = parseListenAddress(line)
        if (token) {
          settle(null, token)
        }
      })
      const detachStderr = onProcessOutputLines(child.stderr, (line) => {
        this.options.logf?.(`[tailcat serve] ${line}`)
      })
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        detachStderr()
        const error = new Error(`tailcat serve exited (${signal ?? code ?? 'unknown'})`)
        if (this.child === child) {
          this.child = null
          if (settled && this.isCurrent(generation)) {
            this.scheduleRestart(generation, error)
          }
        }
        // Why: a launch cancelled by stop() must still settle, or its caller waits out the timeout.
        settle(this.isCurrent(generation) ? error : new TunnelServerCancelledError())
      }
      const onError = (error: Error): void => settle(error)
      const settle = (error: Error | null, token?: string): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        detachStdout()
        child.off('error', onError)
        if (error) {
          if (this.child === child) {
            this.child = null
            void terminateChild(child, this.options.terminateGraceMs)
          }
          reject(error)
          return
        }
        resolve(token!)
      }
      child.on('exit', onExit)
      child.on('error', onError)
    })
  }

  private scheduleRestart(generation: number, error: unknown): void {
    if (this.restartTimer) {
      return
    }
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)] ?? 0
    this.restartAttempt += 1
    const message = error instanceof Error ? error.message : String(error)
    this.options.logf?.(`[tailcat serve] ${message}; restarting in ${delay}ms`)
    this.setState('starting')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.isCurrent(generation)) {
        return
      }
      this.launch(generation).catch(() => {
        // Why: the attempt logs its own failure and has already queued the next retry.
      })
    }, delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.port !== null
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) {
      throw new TunnelServerCancelledError()
    }
  }

  private async ensureServerKey(): Promise<void> {
    if (existsSync(this.options.keyPath)) {
      return
    }
    const run = this.options.run ?? runProcess
    const result = await run({
      program: this.options.binary,
      args: ['genkey', `--key=${tailcatKeyPathArgument(this.options.keyPath)}`, '--fixed-region'],
      timeoutMs: KEYGEN_TIMEOUT_MS
    })
    if (result.code !== 0) {
      throw new Error(`tailcat genkey failed: ${result.stderr.trim() || result.code}`)
    }
  }

  private setState(state: TailcatTunnelServerState): void {
    if (this.state === state) {
      return
    }
    this.state = state
    this.options.onStateChange?.(state)
  }
}

export function parseListenAddress(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { listenAddr?: unknown }
    return typeof parsed.listenAddr === 'string' && parsed.listenAddr.startsWith('tc')
      ? parsed.listenAddr
      : null
  } catch {
    return null
  }
}
