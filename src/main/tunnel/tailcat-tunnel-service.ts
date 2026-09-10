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
  probe?: (binary: string) => Promise<TailcatCompatibility>
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
    const binaryPath = this.getBinaryPath()
    const compatibility = binaryPath ? await this.getCompatibility(binaryPath) : null
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
    const now = this.options.now ?? Date.now
    const cached = this.compatibility
    if (
      cached?.binary === binary &&
      (cached.result.ok || now() - cached.at < FAILED_PROBE_RETRY_MS)
    ) {
      return Promise.resolve(cached.result)
    }
    if (!this.probing) {
      this.probing = (this.options.probe ?? probeTailcatBinary)(binary)
        .then((result) => {
          this.compatibility = { binary, result, at: now() }
          return result
        })
        .finally(() => {
          this.probing = null
        })
    }
    return this.probing
  }

  private async requireUsableBinary(): Promise<string> {
    const binary = this.getBinaryPath()
    if (!binary) {
      throw new Error(TAILCAT_INSTALL_HINT)
    }
    const compatibility = await this.getCompatibility(binary)
    if (!compatibility.ok) {
      throw new Error(compatibility.reason)
    }
    return binary
  }

  /** Starts (or reuses) the tunnel server for the runtime's WebSocket port and returns its address blob. */
  async ensureServer(port: number): Promise<string> {
    const binary = await this.requireUsableBinary()
    if (this.server && this.server.getPort() !== null && this.server.getPort() !== port) {
      await this.server.stop()
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
  dial = async (tunnel: PairingTunnel): Promise<Socket> => {
    const binary = await this.requireUsableBinary()
    if (!this.proxy) {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 })
      this.proxy = new TailcatSocksProxy({
        binary,
        keyPath: join(this.stateDirectory, CLIENT_KEY_FILENAME),
        logf: this.options.logf
      })
    }
    return this.proxy.dial(tunnel)
  }

  async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    await server?.stop()
  }

  async stop(): Promise<void> {
    const proxy = this.proxy
    this.proxy = null
    await Promise.all([this.stopServer(), proxy?.stop()])
  }
}
