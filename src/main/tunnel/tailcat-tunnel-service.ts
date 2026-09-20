import { mkdirSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import type { PairingTunnel } from '../../shared/mobile-relay-pairing-offer'
import { resolveTailcatBinary, TAILCAT_INSTALL_HINT } from './tailcat-binary'
import { TailcatSocksProxy } from './tailcat-socks-proxy'
import { probeTailcatBinary, type TailcatCompatibility } from './tailcat-compatibility'
import { TailcatTunnelServer } from './tailcat-tunnel-server'
import type {
  RuntimeTunnelAdvertiser,
  TailcatTunnelStatus
} from '../../shared/tailcat-tunnel-status'

export type TailcatTunnelServiceOptions = {
  userDataPath: string
  logf?: (message: string) => void
  resolveBinary?: () => string | null
  probe?: (binary: string, signal: AbortSignal) => Promise<TailcatCompatibility>
  now?: () => number
}

// Why: a failed probe must be retried so an in-place upgrade is picked up, but not on every status
// poll; a successful probe holds for the life of the process.
const FAILED_PROBE_RETRY_MS = 30_000

const TAILCAT_STATE_DIRECTORY = 'tailcat'
const SERVER_KEY_FILENAME = 'orca-server.private.json'
const CLIENT_KEY_FILENAME = 'orca-client.private.json'

/**
 * The host process's one owner of tailcat: a server that exposes this runtime's WebSocket port and a
 * client proxy that reaches other hosts' tunnels. Both are lazy, so a host that never shares or joins a
 * tunnel never starts a child.
 */
export class TailcatTunnelService implements RuntimeTunnelAdvertiser {
  private readonly stateDirectory: string
  private readonly resolveBinary: () => string | null
  private binaryPath: string | null | undefined
  private compatibility: { binary: string; result: TailcatCompatibility; at: number } | null = null
  private probing: Promise<TailcatCompatibility> | null = null
  private server: TailcatTunnelServer | null = null
  private proxy: TailcatSocksProxy | null = null
  private readonly lifecycleAbort = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private generation = 0
  private stopped = false

  constructor(private readonly options: TailcatTunnelServiceOptions) {
    this.stateDirectory = join(options.userDataPath, TAILCAT_STATE_DIRECTORY)
    this.resolveBinary = options.resolveBinary ?? (() => resolveTailcatBinary())
  }

  getBinaryPath(): string | null {
    // Why: re-probe while absent so an install made after launch is picked up without a restart.
    if (!this.binaryPath) {
      this.binaryPath = this.resolveBinary()
    }
    return this.binaryPath
  }

  async getStatus(): Promise<TailcatTunnelStatus> {
    const generation = this.generation
    this.assertActive(generation)
    const binaryPath = this.getBinaryPath()
    const compatibility = binaryPath ? await this.getCompatibility(binaryPath) : null
    this.assertActive(generation)
    return {
      installed: binaryPath !== null,
      binaryPath,
      installHint: TAILCAT_INSTALL_HINT,
      compatible: compatibility ? compatibility.ok : null,
      version: compatibility?.version ?? null,
      incompatibleReason: compatibility && !compatibility.ok ? compatibility.reason : null,
      server: {
        state: this.server?.getState() ?? 'stopped',
        port: this.server?.getPort() ?? null
      }
    }
  }

  /**
   * Why probe and not trust the name: any executable called `tailcat` is found on PATH, and releases
   * before 0.4 use a different command syntax that would only surface as supervisor restart loops.
   */
  private getCompatibility(binary: string): Promise<TailcatCompatibility> {
    const generation = this.generation
    this.assertActive(generation)
    const now = this.options.now ?? Date.now
    const cached = this.compatibility
    if (
      cached?.binary === binary &&
      (cached.result.ok || now() - cached.at < FAILED_PROBE_RETRY_MS)
    ) {
      return Promise.resolve(cached.result)
    }
    if (!this.probing) {
      const probing = (
        this.options.probe ?? ((path, signal) => probeTailcatBinary(path, { signal }))
      )(binary, this.lifecycleAbort.signal)
        .then((result) => {
          this.assertActive(generation)
          this.compatibility = { binary, result, at: now() }
          return result
        })
        .finally(() => {
          if (this.probing === probing) {
            this.probing = null
          }
        })
      this.probing = probing
    }
    return this.probing
  }

  private async requireUsableBinary(generation: number): Promise<string> {
    this.assertActive(generation)
    const binary = this.getBinaryPath()
    if (!binary) {
      throw new Error(TAILCAT_INSTALL_HINT)
    }
    const compatibility = await this.getCompatibility(binary)
    this.assertActive(generation)
    if (!compatibility.ok) {
      throw new Error(compatibility.reason)
    }
    return binary
  }

  /** Starts (or reuses) the tunnel server for the runtime's WebSocket port and returns its address blob. */
  ensureServer(port: number): Promise<string> {
    const generation = this.generation
    return this.trackOperation(this.ensureServerActive(port, generation))
  }

  private async ensureServerActive(port: number, generation: number): Promise<string> {
    const binary = await this.requireUsableBinary(generation)
    this.assertActive(generation)
    if (this.server && this.server.getPort() !== null && this.server.getPort() !== port) {
      await this.server.stop()
      this.assertActive(generation)
      this.server = null
    }
    if (!this.server) {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
      this.server = new TailcatTunnelServer({
        binary,
        keyPath: join(this.stateDirectory, SERVER_KEY_FILENAME),
        logf: this.options.logf
      })
    }
    return this.server.start(port)
  }

  getPairingTunnel(port: number): Omit<PairingTunnel, 'port'> | null {
    const token = this.server?.getToken()
    if (!token || this.server?.getState() !== 'running' || this.server.getPort() !== port) {
      return null
    }
    return { v: 1, kind: 'tailcat', token }
  }

  /** Dials another host's tunnel; used as the process-wide remote runtime tunnel dialer. */
  dial = (tunnel: PairingTunnel, signal: AbortSignal): Promise<Socket> => {
    const generation = this.generation
    return this.trackOperation(this.dialActive(tunnel, signal, generation))
  }

  private async dialActive(
    tunnel: PairingTunnel,
    signal: AbortSignal,
    generation: number
  ): Promise<Socket> {
    signal.throwIfAborted()
    const binary = await this.requireUsableBinary(generation)
    signal.throwIfAborted()
    this.assertActive(generation)
    if (!this.proxy) {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
      this.proxy = new TailcatSocksProxy({
        binary,
        keyPath: join(this.stateDirectory, CLIENT_KEY_FILENAME),
        logf: this.options.logf
      })
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    this.lifecycleAbort.signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted || this.lifecycleAbort.signal.aborted) {
      controller.abort()
    }
    try {
      return await this.proxy.dial(tunnel, controller.signal)
    } finally {
      signal.removeEventListener('abort', abort)
      this.lifecycleAbort.signal.removeEventListener('abort', abort)
    }
  }

  async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    await server?.stop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.lifecycleAbort.abort()
    const probing = this.probing
    const operations = [...this.operations]
    const proxy = this.proxy
    this.proxy = null
    await Promise.all([
      this.stopServer(),
      proxy?.stop(),
      probing?.catch(() => {}),
      ...operations.map((operation) => operation.catch(() => {}))
    ])
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    const forget = (): void => {
      this.operations.delete(operation)
    }
    void operation.then(forget, forget)
    return operation
  }

  private assertActive(generation: number): void {
    if (this.stopped || generation !== this.generation) {
      throw new Error('Tailcat tunnel service has been stopped')
    }
  }
}
