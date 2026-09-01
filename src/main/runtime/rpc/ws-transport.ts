// WebSocket transport letting mobile clients reach the Orca runtime over LAN (wss:// with TLS, else ws://); auth is per-device tokens, independent of transport encryption.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'
import { createStaticWebClientHandler } from './static-web-client-handler'
import { canUseBunWebSocketTransport, BunWebSocketTransport } from './bun-websocket-transport'
import {
  attachNodeWebSocketLifecycle,
  rejectNodeWebSocketOverCapacity,
  stopNodeWebSocketTransport,
  type WebSocketMessageHandler
} from './node-websocket-lifecycle'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

const MAX_WS_MESSAGE_BYTES = 1024 * 1024
const MAX_WS_CONNECTIONS = 128
const MAX_TCP_CONNECTIONS = MAX_WS_CONNECTIONS * 2
const PRE_AUTH_TIMEOUT_MS = 10_000

// Why: mobile clients background-suspend sockets with no TCP FIN, leaving half-opens that otherwise only the OS keepalive (~2h) reaps; a 15s ping/pong sweep bounds that to ~60s (clients auto-pong per RFC 6455), since a reap needs consecutive unanswered probes rather than one (STA-3320).
const HEARTBEAT_INTERVAL_MS = 15_000

export type WebSocketTransportOptions = {
  host: string
  port: number
  tlsCert?: string
  tlsKey?: string
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
}

export class WebSocketTransport implements RpcTransport {
  private readonly host: string
  private readonly port: number
  private readonly tlsCert: string | undefined
  private readonly tlsKey: string | undefined
  private readonly heartbeat: RemoteRuntimeServerHeartbeat
  private readonly preAuthTimeoutMs: number
  private readonly staticRoot: string | undefined
  private readonly fallbackPort: number | undefined
  private readonly preferPinnedPort: boolean
  private httpServer: HttpsServer | HttpServer | null = null
  private wss: WebSocketServer | null = null
  private bunTransport: BunWebSocketTransport | null = null
  private messageHandler: WebSocketMessageHandler | null = null
  private connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  // Why: maps each socket to its authenticated clientId so close can report which device disconnected.
  private wsClientIds = new Map<WebSocket, string>()
  private heartbeatConnections = new Set<WebSocket>()
  private preAuthTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()

  constructor({
    host,
    port,
    tlsCert,
    tlsKey,
    heartbeatIntervalMs,
    heartbeatNow,
    preAuthTimeoutMs,
    staticRoot,
    fallbackPort,
    preferPinnedPort
  }: WebSocketTransportOptions) {
    this.host = host
    this.port = port
    this.tlsCert = tlsCert
    this.tlsKey = tlsKey
    this.heartbeat = new RemoteRuntimeServerHeartbeat(
      heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      heartbeatNow,
      MAX_WS_CONNECTIONS
    )
    this.preAuthTimeoutMs = preAuthTimeoutMs ?? PRE_AUTH_TIMEOUT_MS
    this.staticRoot = staticRoot
    this.fallbackPort = fallbackPort
    this.preferPinnedPort = preferPinnedPort === true
  }

  onMessage(handler: WebSocketMessageHandler): void {
    this.messageHandler = handler
  }

  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void {
    this.connectionCloseHandler = handler
  }

  setClientId(ws: WebSocket, clientId: string): void {
    if (this.bunTransport) {
      this.bunTransport.setClientId(ws, clientId)
      return
    }
    this.wsClientIds.set(ws, clientId)
    clearTimeout(this.preAuthTimers.get(ws))
    this.preAuthTimers.delete(ws)
  }

  terminateClientConnections(clientId: string): number {
    if (this.bunTransport) {
      return this.bunTransport.terminateClientConnections(clientId)
    }
    const sockets = Array.from(this.wsClientIds.entries())
      .filter(([, candidateClientId]) => candidateClientId === clientId)
      .map(([ws]) => ws)
    for (const ws of sockets) {
      ws.terminate()
    }
    return sockets.length
  }

  get resolvedPort(): number {
    if (this.bunTransport) {
      return this.bunTransport.resolvedPort
    }
    const addr = this.httpServer?.address()
    return addr && typeof addr === 'object' ? addr.port : this.port
  }

  get resolvedHost(): string | null {
    if (this.bunTransport) {
      return this.bunTransport.resolvedHost
    }
    const addr = this.httpServer?.address()
    return addr && typeof addr === 'object' ? addr.address : null
  }

  async start(): Promise<void> {
    if (canUseBunWebSocketTransport()) {
      this.startBun()
      return
    }
    if (this.wss) {
      return
    }

    // Why: bind a persisted fallback first so devices paired to it aren't stranded (STA-1511); serve --port flips to pinned-first (issue #8535); on failure each candidate falls through to OS-assigned port 0.
    const persistedFallbackPort =
      this.fallbackPort !== undefined && this.fallbackPort !== 0 && this.fallbackPort !== this.port
        ? this.fallbackPort
        : undefined
    const candidatePorts =
      persistedFallbackPort === undefined
        ? [this.port]
        : this.preferPinnedPort
          ? [this.port, persistedFallbackPort]
          : [persistedFallbackPort, this.port]
    for (const port of candidatePorts) {
      try {
        await this.tryListen(port)
        return
      } catch (error) {
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

  private startBun(): void {
    const messageHandler = this.messageHandler
    const connectionCloseHandler = this.connectionCloseHandler
    if (!messageHandler || !connectionCloseHandler) {
      throw new Error('Bun WebSocket transport requires message and close handlers')
    }
    this.bunTransport = new BunWebSocketTransport({
      host: this.host,
      port: this.port,
      staticRoot: this.staticRoot,
      tlsCert: this.tlsCert,
      tlsKey: this.tlsKey,
      preAuthTimeoutMs: this.preAuthTimeoutMs,
      heartbeat: this.heartbeat,
      callbacks: {
        messageHandler,
        connectionCloseHandler
      }
    })
    try {
      this.bunTransport.start()
    } catch (error) {
      this.bunTransport = null
      throw error
    }
  }

  private createHttpServer(): HttpServer | HttpsServer {
    const requestListener = this.staticRoot
      ? createStaticWebClientHandler(this.staticRoot)
      : undefined
    return this.tlsCert && this.tlsKey
      ? createHttpsServer({ cert: this.tlsCert, key: this.tlsKey }, requestListener)
      : createHttpServer(requestListener)
  }

  // Why: attach the WSS only after listen succeeds; earlier it re-emits httpServer's EADDRINUSE as an uncatchable exception and breaks the fallback.
  private async tryListen(port: number): Promise<void> {
    const httpServer = this.createHttpServer()

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, this.host, () => {
        httpServer.off('error', reject)
        resolve()
      })
    })

    // Why: the WS cap applies only post-upgrade; a separate TCP cap bounds raw/pre-upgrade descriptor use.
    httpServer.maxConnections = MAX_TCP_CONNECTIONS

    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: MAX_WS_MESSAGE_BYTES
    })

    wss.on('connection', (ws) => {
      if (wss.clients.size > MAX_WS_CONNECTIONS) {
        this.rejectOverCapacity(ws)
        return
      }
      this.handleConnection(ws)
    })

    this.httpServer = httpServer
    this.wss = wss
  }

  private rejectOverCapacity(ws: WebSocket): void {
    rejectNodeWebSocketOverCapacity(ws)
  }

  async stop(): Promise<void> {
    const bunTransport = this.bunTransport
    this.bunTransport = null
    if (bunTransport) {
      await bunTransport.stop()
      return
    }
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
      getClients: () => this.wss?.clients ?? [],
      messageHandler: this.messageHandler,
      connectionCloseHandler: this.connectionCloseHandler
    })
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
