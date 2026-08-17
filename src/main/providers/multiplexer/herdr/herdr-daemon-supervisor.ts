import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { getDefaultSocketPath as getHerdrTransportSocketPath } from './herdr-transport'

export type HerdrDaemonStatus = 'stopped' | 'starting' | 'ready' | 'unavailable'

export type HerdrDaemonSupervisorOptions = {
  entryPath: string
  runtimeDir: string
  socketPath?: string
  env?: NodeJS.ProcessEnv
  pingTimeoutMs?: number
  startBudgetMs?: number
  retryIntervalMs?: number
  maxRetryIntervalMs?: number
  livenessIntervalMs?: number
  // Injectable for tests.
  spawn?: typeof fork
  pingSocket?: (socketPath: string, timeoutMs: number) => Promise<void>
}

const DEFAULT_PING_TIMEOUT_MS = 1_000
const DEFAULT_START_BUDGET_MS = 5_000
const DEFAULT_RETRY_INTERVAL_MS = 500
const DEFAULT_MAX_RETRY_INTERVAL_MS = 30_000
const DEFAULT_LIVENESS_INTERVAL_MS = 5_000
const PROBE_INTERVAL_MS = 100
const MAX_EXPONENT = 10

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function pingHerdrSocket(socketPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`ping to ${socketPath} timed out`))
    }, timeoutMs)

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: randomUUID(), method: 'ping', params: {} })}\n`)
    })
    socket.on('data', (chunk) => {
      if (chunk.toString('utf8').trim()) {
        finish()
      }
    })
    socket.once('error', (error) => {
      finish(error)
    })
    socket.once('close', () => {
      finish(new Error(`connection to ${socketPath} closed before a response`))
    })
  })
}

// Owns the in-app herdr daemon child lifecycle: spawn, readiness via socket ping,
// liveness monitoring, and restart with backoff. Never blocks or rejects boot.
export class HerdrDaemonSupervisor {
  private readonly socketPath: string
  private readonly env: NodeJS.ProcessEnv
  private child: ChildProcess | null = null
  private status: HerdrDaemonStatus = 'stopped'
  private stopping = false
  private attempt = 0
  private readyResolvers: (() => void)[] = []
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: HerdrDaemonSupervisorOptions) {
    this.socketPath = options.socketPath ?? getHerdrTransportSocketPath()
    this.env = options.env ?? {}
  }

  getStatus(): HerdrDaemonStatus {
    return this.status
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get retryAttempt(): number {
    return this.attempt
  }

  onceReady(): Promise<void> {
    if (this.status === 'ready') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve)
    })
  }

  start(): void {
    if (this.child || this.status !== 'stopped') {
      return
    }
    this.stopping = false
    this.spawnAttempt()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const child = this.child
    this.child = null
    if (child) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        child.once('exit', done)
        const failsafe = setTimeout(done, 2_000)
        failsafe.unref?.()
      })
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
    this.status = 'stopped'
    this.attempt = 0
  }

  private spawnAttempt(): void {
    this.clearRetryTimer()
    this.status = 'starting'
    mkdirSync(dirname(this.socketPath), { recursive: true })
    this.unlinkSocket()

    const spawn = this.options.spawn ?? fork
    const entryPath = this.options.entryPath
    const child = spawn(entryPath, ['daemon'], {
      cwd: this.options.runtimeDir,
      env: {
        ...process.env,
        ...this.env,
        HERDR_SOCKET_PATH: this.socketPath,
        ORCA_RUNTIME_DIR: this.options.runtimeDir
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    this.child = child

    child.stdout?.on('data', (chunk) => {
      console.error(`[herdr-daemon] ${String(chunk).trimEnd()}`)
    })
    child.stderr?.on('data', (chunk) => {
      console.error(`[herdr-daemon] ${String(chunk).trimEnd()}`)
    })

    child.on('error', (error) => {
      console.error('[herdr-daemon] spawn error:', error.message)
      this.handleDown('spawn_error')
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return
      }
      this.child = null
      this.clearLivenessTimer()
      if (this.stopping) {
        return
      }
      console.error(`[herdr-daemon] exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      this.handleDown('exit')
    })

    void this.waitForReady(child)
  }

  private async waitForReady(child: ChildProcess): Promise<void> {
    const budgetMs = this.options.startBudgetMs ?? DEFAULT_START_BUDGET_MS
    const pingTimeoutMs = this.options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
    const ping = this.options.pingSocket ?? pingHerdrSocket
    const deadline = Date.now() + budgetMs

    while (Date.now() < deadline) {
      if (this.stopping || this.child !== child) {
        return
      }
      try {
        await ping(this.socketPath, pingTimeoutMs)
        if (this.stopping || this.child !== child) {
          return
        }
        this.status = 'ready'
        this.attempt = 0
        this.startLivenessMonitor()
        for (const resolve of this.readyResolvers.splice(0)) {
          resolve()
        }
        return
      } catch {
        if (this.stopping || this.child !== child) {
          return
        }
        await delay(PROBE_INTERVAL_MS)
      }
    }

    if (!this.stopping && this.child === child) {
      this.status = 'unavailable'
      this.scheduleRestart()
    }
  }

  private handleDown(_reason: 'exit' | 'spawn_error'): void {
    if (this.stopping) {
      return
    }
    if (this.status === 'ready') {
      this.status = 'unavailable'
    }
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.retryTimer) {
      return
    }
    const base = this.options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    const cap = this.options.maxRetryIntervalMs ?? DEFAULT_MAX_RETRY_INTERVAL_MS
    const delayMs = Math.min(base * 2 ** this.attempt, cap)
    this.attempt = Math.min(this.attempt + 1, MAX_EXPONENT)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopping) {
        this.spawnAttempt()
      }
    }, delayMs)
  }

  private startLivenessMonitor(): void {
    this.clearLivenessTimer()
    const intervalMs = this.options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS
    const pingTimeoutMs = this.options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
    const ping = this.options.pingSocket ?? pingHerdrSocket
    this.livenessTimer = setInterval(() => {
      if (this.stopping || this.status !== 'ready') {
        return
      }
      void ping(this.socketPath, pingTimeoutMs).catch(() => {
        if (this.stopping || this.status !== 'ready') {
          return
        }
        this.status = 'unavailable'
        const child = this.child
        this.child = null
        child?.kill('SIGKILL')
        this.scheduleRestart()
      })
    }, intervalMs)
  }

  private unlinkSocket(): void {
    try {
      unlinkSync(this.socketPath)
    } catch {
      // No stale socket to clean up.
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private clearTimers(): void {
    this.clearRetryTimer()
    this.clearLivenessTimer()
  }
}
