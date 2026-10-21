// WebSocket transport letting mobile clients reach the Orca runtime over LAN (ws://); auth is per-device tokens, and E2EE runs above this layer.
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'
import { answerWithoutWebClient, createStaticWebClientHandler } from './static-web-client-handler'
import {
  attachNodeWebSocketLifecycle,
  clearNodeWebSocketPreAuthTimer,
  rejectNodeWebSocketOverCapacity,
  stopNodeWebSocketTransport,
  type WebSocketConnectionCloseHandler,
  type WebSocketMessageHandler
} from './node-websocket-lifecycle'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'
import { assertPortNotShadowingListener } from './shadowed-port-probe'
import { REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES } from '../../../shared/remote-runtime-memory-limits'

export const WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES = REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES
// Why: one desktop remote-host client can hold many concurrent streams, so keep the cap high enough that stale streams don't starve control RPCs.
const WEBSOCKET_TRANSPORT_MAX_CONNECTIONS = 128
// Why: bound pre-upgrade descriptor use above the WS cap so raw sockets can't grow without bound.
const WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS = WEBSOCKET_TRANSPORT_MAX_CONNECTIONS * 2

const PRE_AUTH_TIMEOUT_MS = 10_000

// Why: mobile clients background-suspend sockets with no TCP FIN, leaving half-opens that otherwise only the OS keepalive (~2h) reaps; a 15s ping/pong sweep bounds that to ~60s (clients auto-pong per RFC 6455), since a reap needs consecutive unanswered probes rather than one (STA-3320).
const HEARTBEAT_INTERVAL_MS = 15_000

export type WebSocketTransportOptions = {
  host: string
  port: number
  // Why: test-only override. Production uses HEARTBEAT_INTERVAL_MS.
  heartbeatIntervalMs?: number
  // Why: deterministic suspension tests must advance wall time independently from timer callbacks.
  heartbeatNow?: () => number
  // Why: test-only override. Production uses PRE_AUTH_TIMEOUT_MS.
  preAuthTimeoutMs?: number
  // Why: the pairing server can also serve the browser client, avoiding a second static server.
  staticRoot?: string
  // Why: devices paired while the fallback port was active point at it, so it must bind first on later launches or those pairings strand (STA-1511).
  fallbackPort?: number
  // Why: serve --port clients dial the pinned port; prefer it first so a stale fallback can't steal the pin (issue #8535). Default keeps fallback-first (STA-1511).
  preferPinnedPort?: boolean
  // Why: an explicit `orca serve --port` must fail when that port is taken, not move elsewhere (#26603).
  requirePinnedPort?: boolean
  // Why: deterministic ports tried before an OS-assigned one, so a fallback stays stable across reboots.
  fallbackLadder?: readonly number[]
}

export class WebSocketTransport implements RpcTransport {
  private readonly host: string
  private readonly port: number
  private readonly heartbeat: RemoteRuntimeServerHeartbeat
  private readonly preAuthTimeoutMs: number
  private readonly staticRoot: string | undefined
  private readonly fallbackPort: number | undefined
  private readonly preferPinnedPort: boolean
  private readonly requirePinnedPort: boolean
  private readonly fallbackLadder: readonly number[]
  private persistedFallbackBindFailed = false
  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private messageHandler: WebSocketMessageHandler | null = null
  private connectionCloseHandler: WebSocketConnectionCloseHandler | null = null
  // Why: maps each socket to its authenticated clientId so close can report which device disconnected.
  private wsClientIds = new Map<WebSocket, string>()
  private heartbeatConnections = new Set<WebSocket>()
  private preAuthTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

  constructor({
    host,
    port,
    heartbeatIntervalMs,
    heartbeatNow,
    preAuthTimeoutMs,
    staticRoot,
    fallbackPort,
    preferPinnedPort,
    requirePinnedPort,
    fallbackLadder
  }: WebSocketTransportOptions) {
    this.host = host
    this.port = port
    this.heartbeat = new RemoteRuntimeServerHeartbeat(
      heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      heartbeatNow,
      WEBSOCKET_TRANSPORT_MAX_CONNECTIONS
    )
    this.preAuthTimeoutMs = preAuthTimeoutMs ?? PRE_AUTH_TIMEOUT_MS
    this.staticRoot = staticRoot
    this.fallbackPort = fallbackPort
    this.preferPinnedPort = preferPinnedPort === true
    this.requirePinnedPort = requirePinnedPort === true
    this.fallbackLadder = fallbackLadder ?? []
  }

  // True when the persisted fallback was tried and refused, so the caller can drop it.
  get persistedFallbackFailed(): boolean {
    return this.persistedFallbackBindFailed
  }

  onMessage(handler: WebSocketMessageHandler): void {
    this.messageHandler = handler
  }

  // Why: pass the closing `ws` and whether other sockets share its client id (the device id), so client-scoped teardown fires only on the last disconnect.
  onConnectionClose(handler: WebSocketConnectionCloseHandler): void {
    this.connectionCloseHandler = handler
  }

  setClientId(ws: WebSocket, clientId: string): void {
    this.wsClientIds.set(ws, clientId)
    clearNodeWebSocketPreAuthTimer(ws, this.preAuthTimers)
  }

  terminateClientConnections(clientId: string): number {
    const sockets = Array.from(this.wsClientIds.entries())
      .filter(([, candidateClientId]) => candidateClientId === clientId)
      .map(([ws]) => ws)
    for (const ws of sockets) {
      // Why: revocation is a security boundary; terminate() skips the handshake so a revoked stream stops immediately.
      ws.terminate()
    }
    return sockets.length
  }

  // Why: with port 0 the OS assigns a random port; callers read the real bound port here for metadata and the mobile QR.
  get resolvedPort(): number {
    const addr = this.httpServer?.address()
    if (addr && typeof addr === 'object') {
      return addr.port
    }
    return this.port
  }

  // Why: the actual OS-reported bind interface, so callers can verify loopback vs all-interfaces (STA-2370).
  get resolvedHost(): string | null {
    const addr = this.httpServer?.address()
    return addr && typeof addr === 'object' ? addr.address : null
  }

  async start(): Promise<void> {
    if (this.wss) {
      return
    }
    if (this.requirePinnedPort) {
      await this.tryListen(this.port).catch((error: unknown) => {
        throw isPortListenFallbackError(error, this.port)
          ? new PinnedPortUnavailableError(this.host, this.port, error)
          : error
      })
      return
    }
    // Why: bind a persisted fallback first so devices paired to it aren't stranded (STA-1511); serve --port flips to pinned-first (issue #8535); then the deterministic ladder, and only then an OS-assigned port 0.
    const persistedFallbackPort =
      this.fallbackPort !== undefined && this.fallbackPort !== 0 && this.fallbackPort !== this.port
        ? this.fallbackPort
        : undefined
    const configuredPorts =
      persistedFallbackPort === undefined
        ? [this.port]
        : this.preferPinnedPort
          ? [this.port, persistedFallbackPort]
          : [persistedFallbackPort, this.port]
    const candidatePorts = [
      ...configuredPorts,
      ...this.fallbackLadder.filter((port) => !configuredPorts.includes(port))
    ]
    for (const port of candidatePorts) {
      try {
        await this.tryListen(port)
        return
      } catch (error: unknown) {
        if (port === persistedFallbackPort) {
          this.persistedFallbackBindFailed = true
        }
        // Why: a persisted fallback may fail for any reason, while configured ports fall through only when their listen is occupied or denied.
        if (
          port !== persistedFallbackPort &&
          (!isPortListenFallbackError(error, port) || port === 0)
        ) {
          throw error
        }
        console.warn(
          `[ws-transport] Failed to bind port ${port} (${error instanceof Error ? error.message : String(error)}), trying next candidate`
        )
      }
    }
    console.warn('[ws-transport] All configured ports failed to bind, using an OS-assigned port')
    await this.tryListen(0)
  }

  // Why: attach the WSS only after listen succeeds; earlier it re-emits httpServer's EADDRINUSE as an uncatchable exception and breaks the fallback.
  private async tryListen(port: number): Promise<void> {
    await assertPortNotShadowingListener(this.host, port)
    // Why the 404: with no 'request' listener Node never answers plain HTTP, so it hung (#30100).
    const httpServer = createHttpServer(
      this.staticRoot ? createStaticWebClientHandler(this.staticRoot) : answerWithoutWebClient
    )

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, this.host, () => {
        httpServer.off('error', reject)
        resolve()
      })
    })

    // Why: the WS cap applies only post-upgrade; a separate TCP cap bounds raw/pre-upgrade descriptor use.
    httpServer.maxConnections = WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS

    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES
    })

    wss.on('connection', (ws) => {
      if (wss.clients.size > WEBSOCKET_TRANSPORT_MAX_CONNECTIONS) {
        rejectNodeWebSocketOverCapacity(ws)
        return
      }
      this.handleConnection(ws)
    })

    this.httpServer = httpServer
    this.wss = wss
  }

  async stop(): Promise<void> {
    const wss = this.wss
    const httpServer = this.httpServer
    this.wss = null
    this.httpServer = null
    await stopNodeWebSocketTransport({
      wss,
      httpServer,
      heartbeat: this.heartbeat,
      heartbeatConnections: this.heartbeatConnections
    })
  }

  private handleConnection(ws: WebSocket): void {
    attachNodeWebSocketLifecycle({
      ws,
      heartbeat: this.heartbeat,
      preAuthTimeoutMs: this.preAuthTimeoutMs,
      preAuthTimers: this.preAuthTimers,
      clientIds: this.wsClientIds,
      heartbeatConnections: this.heartbeatConnections,
      getMessageHandler: () => this.messageHandler,
      getConnectionCloseHandler: () => this.connectionCloseHandler
    })
  }
}

export class PinnedPortUnavailableError extends Error {
  readonly code = 'pinned_port_unavailable'

  constructor(host: string, port: number, cause: unknown) {
    const reason = cause instanceof Error && 'code' in cause ? String(cause.code) : 'unavailable'
    super(
      `Port ${port} on ${host} is unavailable (${reason}). Stop whatever is using it, or pass a different --port.`,
      { cause }
    )
    this.name = 'PinnedPortUnavailableError'
  }
}

function isPortListenFallbackError(error: unknown, port: number): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  if (error.code === 'EADDRINUSE') {
    return true
  }
  return (
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}
