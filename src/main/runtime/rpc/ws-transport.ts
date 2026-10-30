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
import { REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'

export const WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES = REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES
// Allow many remote-desktop streams so stale ones cannot starve control RPCs.
const WEBSOCKET_TRANSPORT_MAX_CONNECTIONS = 128
// Bound pre-upgrade descriptors independently above the WS cap.
const WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS = WEBSOCKET_TRANSPORT_MAX_CONNECTIONS * 2

const PRE_AUTH_TIMEOUT_MS = 10_000

// Background phones leave half-opens without FIN; 15s probes plus consecutive misses bound ~2h OS cleanup to ~60s (STA-3320).
const HEARTBEAT_INTERVAL_MS = 15_000

export type WebSocketTransportOptions = {
  host: string
  port: number
  // Why: test-only override. Production uses HEARTBEAT_INTERVAL_MS.
  heartbeatIntervalMs?: number
  // Suspend tests advance wall time independently from timer callbacks.
  heartbeatNow?: () => number
  // Why: test-only override. Production uses PRE_AUTH_TIMEOUT_MS.
  preAuthTimeoutMs?: number
  // Serve browser assets from the pairing server to avoid another listener.
  staticRoot?: string
  // Retry persisted fallback first so previously paired endpoints remain reachable (STA-1511).
  fallbackPort?: number
  // Explicit serve pins precede stale fallbacks (#8535); defaults retain fallback-first for pairings.
  preferPinnedPort?: boolean
  // Strict serve pins must refuse occupied ports rather than move (#26603).
  requirePinnedPort?: boolean
  // Deterministic rungs precede port 0 to keep fallbacks stable across reboots.
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
  // Track authenticated device ids so close can attribute disconnects.
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

  // Pass socket and same-device peers so client-scoped cleanup runs only on last disconnect.
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
      // Revocation must stop streams immediately; terminate skips the close handshake.
      ws.terminate()
    }
    return sockets.length
  }

  // Port 0 chooses a port at bind; advertise the actual port in metadata/QR.
  get resolvedPort(): number {
    const addr = this.httpServer?.address()
    if (addr && typeof addr === 'object') {
      return addr.port
    }
    return this.port
  }

  // Expose actual bound interface to verify loopback versus all-interface scope (STA-2370).
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
    // Keep pairings on persisted fallback, unless explicitly pinned; try deterministic rungs before port 0 (STA-1511, #8535).
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
        // Any fallback error may advance; configured ports advance only for occupied/denied binds.
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

  // Attach WSS after successful listen or EADDRINUSE becomes an uncatchable re-emitted exception.
  private async tryListen(port: number): Promise<void> {
    await assertPortNotShadowingListener(this.host, port)
    // Without an HTTP request listener, plain HTTP hangs instead of receiving 404 (#30100).
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

    // Post-upgrade WS cap cannot bound raw TCP descriptors.
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
