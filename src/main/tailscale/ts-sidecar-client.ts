import { spawn, type ChildProcess } from 'child_process'
import { connect, type Socket } from 'net'
import { once } from 'events'
import { SidecarControlConnection, type TailscaleStatus } from './ts-sidecar-control-connection'
import type { TailscaleTransportResolver } from '../ssh/ssh-tailscale-transport'
import type { TailscaleSocksProxy } from '../ssh/ssh-tailscale-dialer'

const READY_PREFIX = 'ORCA-TS-SIDECAR-READY '
const READY_TIMEOUT_MS = 15_000

export type TsSidecarClientOptions = {
  binaryPath: string
  stateDir: string
  socketPath: string
  tokenPath: string
  /** Shared secret written to tokenPath and used to authenticate the control
   *  socket; the sidecar reads the same file. */
  token: string
  hostname: string
  /** When set, the sidecar accepts tailnet connections on this port and
   *  reverse-proxies them to 127.0.0.1:<port> — used to expose the desktop's
   *  WebSocket server over the tailnet. */
  inboundPort?: number
  onState?: (status: TailscaleStatus) => void
  logger?: (message: string) => void
}

// Why: the imperative shell that owns the sidecar process lifecycle. It spawns
// the binary, waits for its readiness sentinel, opens the control socket, and
// exposes the SOCKS5 proxy to the SSH transport. The wire protocol it speaks
// lives in SidecarControlConnection, which is unit-tested independently.
export class TsSidecarClient implements TailscaleTransportResolver {
  private process: ChildProcess | null = null
  private socket: Socket | null = null
  private connection: SidecarControlConnection | null = null
  private starting: Promise<SidecarControlConnection> | null = null
  private lastStatus: TailscaleStatus | null = null

  constructor(private readonly options: TsSidecarClientOptions) {}

  /** TailscaleTransportResolver: ensure the tailnet is reachable and return the
   *  loopback SOCKS5 proxy. Rejects if the node is not logged in. */
  async resolveSocksProxy(): Promise<TailscaleSocksProxy> {
    const connection = await this.ensureStarted()
    const status = await connection.up()
    this.lastStatus = status
    if (status.state !== 'Running') {
      throw new Error(
        status.authUrl
          ? 'Tailnet sidecar needs login before it can reach tailnet hosts'
          : `Tailnet sidecar is not connected (state: ${status.state})`
      )
    }
    if (!status.socksPort) {
      throw new Error('Tailnet sidecar did not report a SOCKS5 port')
    }
    return { host: '127.0.0.1', port: status.socksPort }
  }

  async getStatus(): Promise<TailscaleStatus> {
    const connection = await this.ensureStarted()
    const status = await connection.status()
    this.lastStatus = status
    return status
  }

  /** Last known status without starting the sidecar. Null until first contact,
   *  so reading status (e.g. to render a badge) never spawns a tailnet node. */
  peekStatus(): TailscaleStatus | null {
    return this.lastStatus
  }

  /** Begin interactive login; returns the status carrying the auth URL. */
  async login(): Promise<TailscaleStatus> {
    const connection = await this.ensureStarted()
    const status = await connection.up()
    this.lastStatus = status
    return status
  }

  private ensureStarted(): Promise<SidecarControlConnection> {
    if (this.connection) {
      return Promise.resolve(this.connection)
    }
    if (!this.starting) {
      this.starting = this.start().catch((err) => {
        this.starting = null
        throw err
      })
    }
    return this.starting
  }

  private async start(): Promise<SidecarControlConnection> {
    await writeTokenFile(this.options.tokenPath, this.options.token)

    const args = [
      '--socket',
      this.options.socketPath,
      '--token',
      this.options.tokenPath,
      '--state-dir',
      this.options.stateDir,
      '--hostname',
      this.options.hostname
    ]
    if (this.options.inboundPort) {
      args.push('--inbound-port', String(this.options.inboundPort))
    }
    const child = spawn(this.options.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child
    child.on('exit', () => this.handleProcessExit())
    child.stderr?.on('data', (d: Buffer) =>
      this.options.logger?.(`ts-sidecar: ${d.toString().trim()}`)
    )

    await waitForReadySentinel(child, READY_TIMEOUT_MS)

    const socket = await connectControlSocket(this.options.socketPath)
    this.socket = socket
    const connection = new SidecarControlConnection(
      socket,
      this.options.token,
      (status) => {
        this.lastStatus = status
        this.options.onState?.(status)
      },
      (err) => this.options.logger?.(`ts-sidecar parse error: ${err.message}`)
    )
    await connection.hello()
    this.connection = connection
    return connection
  }

  private handleProcessExit(): void {
    this.connection?.dispose()
    this.connection = null
    this.starting = null
    this.socket = null
    this.process = null
  }

  dispose(): void {
    this.connection?.dispose()
    this.connection = null
    this.starting = null
    this.socket?.destroy()
    this.socket = null
    this.process?.kill()
    this.process = null
  }
}

function waitForReadySentinel(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(
      () => fail(new Error('ts-sidecar did not signal readiness in time')),
      timeoutMs
    )

    function cleanup(): void {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    function fail(err: Error): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      child.kill()
      reject(err)
    }
    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf8')
      const line = buffer.split('\n').find((l) => l.startsWith(READY_PREFIX))
      if (line && !settled) {
        settled = true
        cleanup()
        resolve(Number(line.slice(READY_PREFIX.length).trim()))
      }
    }
    function onExit(code: number | null): void {
      fail(new Error(`ts-sidecar exited before readiness (code ${code})`))
    }
    function onError(err: Error): void {
      fail(err)
    }

    child.stdout?.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

async function connectControlSocket(socketPath: string): Promise<Socket> {
  const socket = connect(socketPath)
  await once(socket, 'connect')
  return socket
}

async function writeTokenFile(path: string, token: string): Promise<void> {
  const { writeFile } = await import('fs/promises')
  await writeFile(path, token, { mode: 0o600 })
}
