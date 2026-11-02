import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import type { PublicTunnelStatus } from '../../../shared/public-tunnel-types'

export type CloudflareTunnelStatus = PublicTunnelStatus

export type CloudflareTunnelState = {
  status: CloudflareTunnelStatus
  publicUrl: string | null
  error: string | null
  startedAt: number | null
}

export type CloudflareTunnelStartFailure = {
  ok: false
  reason: 'cloudflared_not_found' | 'start_failed' | 'timeout'
  message: string
}

export type CloudflareTunnelStartResult =
  | { ok: true; publicUrl: string }
  | CloudflareTunnelStartFailure

export type CloudflareTunnelManagerOptions = {
  /** Override for tests or a bundled binary; defaults to `cloudflared` on PATH. */
  binaryPath?: string
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  onStateChange?: (state: CloudflareTunnelState) => void
  /** Test seam. Production always uses node:child_process.spawn. */
  spawnProcess?: typeof spawn
  now?: () => number
}

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/iu
const OUTPUT_TAIL_LIMIT = 4_000
const URL_SCAN_BUFFER_LIMIT = 2_000

const IDLE_STATE: CloudflareTunnelState = {
  status: 'idle',
  publicUrl: null,
  error: null,
  startedAt: null
}

/**
 * Owns one cloudflared Quick Tunnel. It deliberately listens on loopback via
 * `--url http://127.0.0.1:<port>`: the public edge terminates TLS and only the
 * outbound connection leaves this machine, so no network listener is widened.
 */
export class CloudflareTunnelManager {
  private readonly binaryPath: string
  private readonly startupTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly now: () => number
  private readonly spawnProcess: typeof spawn
  private state: CloudflareTunnelState = IDLE_STATE
  private child: ChildProcess | null = null
  private activePort: number | null = null
  private startPromise: Promise<CloudflareTunnelStartResult> | null = null
  private resolveStart: ((result: CloudflareTunnelStartResult) => void) | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private outputTail = ''
  private urlScanBuffer = ''

  constructor(private readonly options: CloudflareTunnelManagerOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.ORCA_CLOUDFLARED_PATH ?? 'cloudflared'
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
    this.now = options.now ?? Date.now
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  getState(): CloudflareTunnelState {
    return { ...this.state }
  }

  async start(args: { localPort: number }): Promise<CloudflareTunnelStartResult> {
    if (!Number.isInteger(args.localPort) || args.localPort <= 0 || args.localPort > 65_535) {
      return {
        ok: false,
        reason: 'start_failed',
        message: `Invalid local runtime port: ${args.localPort}`
      }
    }
    if (this.state.status === 'connected' && this.activePort === args.localPort) {
      return { ok: true, publicUrl: this.state.publicUrl as string }
    }
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.child) {
      await this.stop()
    }
    this.activePort = args.localPort
    return this.spawnTunnel(args.localPort)
  }

  async stop(): Promise<CloudflareTunnelState> {
    const child = this.child
    if (!child) {
      this.setState(IDLE_STATE)
      return this.getState()
    }
    this.clearStartupTimer()
    if (this.state.status !== 'stopping') {
      this.setState({ ...this.state, status: 'stopping' })
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(forceKillTimer)
        resolve()
      }
      const forceKillTimer = setTimeout(() => {
        // A wedged cloudflared must not keep the tunnel flag permanently on; the
        // state is cleared even if the OS does not report the exit promptly.
        try {
          child.kill('SIGKILL')
        } catch {
          // The process may already be gone.
        }
        finish()
      }, this.stopTimeoutMs)
      child.once('exit', finish)
      try {
        child.kill('SIGTERM')
      } catch {
        finish()
      }
    })
    if (this.child === child) {
      this.child = null
    }
    this.activePort = null
    this.resolveStartFailure(
      {
        ok: false,
        reason: 'start_failed',
        message: 'The public tunnel was stopped before it became ready.'
      },
      false
    )
    this.setState(IDLE_STATE)
    return this.getState()
  }

  /** Drop the tunnel quietly when the desktop is quitting. */
  dispose(): void {
    const child = this.child
    this.child = null
    this.activePort = null
    this.clearStartupTimer()
    this.resolveStartFailure(
      { ok: false, reason: 'start_failed', message: 'The tunnel was disposed.' },
      false
    )
    this.setState(IDLE_STATE)
    try {
      child?.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }

  parseTunnelUrl(line: string): string | null {
    const match = line.match(TRYCLOUDFLARE_URL)
    return match ? match[0].toLowerCase() : null
  }

  generateToken(): string {
    return crypto.randomBytes(18).toString('base64url')
  }

  private spawnTunnel(localPort: number): Promise<CloudflareTunnelStartResult> {
    this.outputTail = ''
    this.urlScanBuffer = ''
    this.setState({
      status: 'starting',
      publicUrl: null,
      error: null,
      startedAt: null
    })
    this.startPromise = new Promise<CloudflareTunnelStartResult>((resolve) => {
      this.resolveStart = resolve
    })
    this.startupTimer = setTimeout(() => {
      this.failStart({
        ok: false,
        reason: 'timeout',
        message: `cloudflared did not publish a public URL within ${this.startupTimeoutMs}ms.`
      })
    }, this.startupTimeoutMs)

    let child: ChildProcess
    try {
      // Quick tunnels do not need an account. stderr carries the banner in every
      // released cloudflared; stdout is read too because the transport is not API-stable.
      child = this.spawnProcess(
        this.binaryPath,
        ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
    } catch (error) {
      this.failStart({
        ok: false,
        reason: 'start_failed',
        message: error instanceof Error ? error.message : String(error)
      })
      return this.startPromise
    }

    this.child = child
    child.stdout?.on('data', (chunk: Buffer | string) => this.consumeOutput(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => this.consumeOutput(chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.failStart({
        ok: false,
        reason: error.code === 'ENOENT' ? 'cloudflared_not_found' : 'start_failed',
        message:
          error.code === 'ENOENT'
            ? `cloudflared was not found. Install it or set ORCA_CLOUDFLARED_PATH.`
            : error.message
      })
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        return
      }
      this.child = null
      this.activePort = null
      const reason = `cloudflared exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).`
      if (this.state.status === 'starting') {
        this.failStart({ ok: false, reason: 'start_failed', message: reason })
        return
      }
      this.setState({
        status: 'error',
        publicUrl: null,
        error: reason,
        startedAt: this.state.startedAt
      })
    })
    return this.startPromise
  }

  private consumeOutput(chunk: Buffer | string): void {
    const text = chunk.toString()
    this.outputTail = `${this.outputTail}${text}`.slice(-OUTPUT_TAIL_LIMIT)
    if (this.state.status !== 'starting') {
      return
    }
    this.urlScanBuffer = `${this.urlScanBuffer}${text}`.slice(-URL_SCAN_BUFFER_LIMIT)
    const publicUrl = this.parseTunnelUrl(this.urlScanBuffer)
    if (!publicUrl) {
      return
    }
    this.urlScanBuffer = ''
    this.clearStartupTimer()
    this.setState({
      status: 'connected',
      publicUrl,
      error: null,
      startedAt: this.now()
    })
    const resolve = this.resolveStart
    this.resolveStart = null
    this.startPromise = null
    resolve?.({ ok: true, publicUrl })
  }

  private failStart(failure: CloudflareTunnelStartFailure): void {
    this.clearStartupTimer()
    const child = this.child
    this.child = null
    this.activePort = null
    try {
      child?.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    this.setState({
      status: 'error',
      publicUrl: null,
      error: failure.message,
      startedAt: null
    })
    const resolve = this.resolveStart
    this.resolveStart = null
    this.startPromise = null
    resolve?.(failure)
  }

  private resolveStartFailure(
    failure: CloudflareTunnelStartFailure,
    clearStartupTimer: boolean
  ): void {
    if (clearStartupTimer) {
      this.clearStartupTimer()
    }
    const resolve = this.resolveStart
    if (!resolve) {
      return
    }
    this.resolveStart = null
    this.startPromise = null
    resolve(failure)
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  private setState(state: CloudflareTunnelState): void {
    this.state = state
    this.options.onStateChange?.(this.getState())
  }
}

/** A browser credential belongs in the fragment: it never reaches a proxy or Referer header. */
export function buildRemoteWebClientUrl(publicUrl: string, pairingPayload: string): string {
  const url = new URL(publicUrl)
  url.protocol = 'https:'
  url.pathname = '/remote'
  url.search = ''
  url.hash = `pairing=${encodeURIComponent(pairingPayload)}`
  return url.toString()
}
