// WebSocket transport letting mobile clients reach the Orca runtime over LAN (wss:// with TLS, else ws://); auth is per-device tokens, independent of transport encryption.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'
import { createStaticWebClientHandler } from './static-web-client-handler'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

const MAX_WS_MESSAGE_BYTES = 1024 * 1024
// Why: one desktop remote-host client can hold many concurrent streams, so keep the cap high enough that stale streams don't starve control RPCs.
const MAX_WS_CONNECTIONS = 128
// Why: bound pre-upgrade descriptor use above the WS cap so raw sockets can't grow without bound.
const MAX_TCP_CONNECTIONS = MAX_WS_CONNECTIONS * 2
const PRE_AUTH_TIMEOUT_MS = 10_000
type WebSocketMessagePayload = string | Uint8Array<ArrayBufferLike>
type WebSocketMessageHandler = {
  bivarianceHack(
    msg: WebSocketMessagePayload,
    reply: (response: string) => void,
    ws: WebSocket
  ): void
}['bivarianceHack']

// Why: mobile clients background-suspend sockets with no TCP FIN, leaving half-opens that otherwise only the OS keepalive (~2h) reaps; a 15s ping/pong sweep bounds that to ~30s (clients auto-pong per RFC 6455).
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
  private messageHandler: WebSocketMessageHandler | null = null
  private connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  // Why: maps each socket to its authenticated clientId so close can report which device disconnected.
  private wsClientIds = new Map<WebSocket, string>()
  private heartbeatConnections = new Set<WebSocket>()
  private preAuthTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

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

  // Why: pass the closing `ws` and whether other sockets share its deviceToken, so client-scoped teardown fires only on the last disconnect.
  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void {
    this.connectionCloseHandler = handler
  }

  setClientId(ws: WebSocket, clientId: string): void {
    this.wsClientIds.set(ws, clientId)
    this.clearPreAuthTimer(ws)
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

  async start(): Promise<void> {
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
      } catch (error: unknown) {
        // Why: any fallback-port failure must degrade to the next candidate (Windows can reserve the port → EACCES, not just EADDRINUSE); only non-EADDRINUSE preferred-port failures are fatal.
        if (port !== persistedFallbackPort && (!isEAddressInUse(error) || port === 0)) {
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

  // Why: force-terminate soon after the 1013 close since a half-open phone may never ack and would hold the descriptor past the WS cap; the 'error' listener absorbs a reset while closing.
  private rejectOverCapacity(ws: WebSocket): void {
    ws.on('error', () => {})
    ws.close(1013, 'Maximum connections reached')
    const terminateTimer = setTimeout(() => ws.terminate(), 1_000)
    terminateTimer.unref?.()
    ws.once('close', () => clearTimeout(terminateTimer))
  }

  async stop(): Promise<void> {
    const wss = this.wss
    const httpServer = this.httpServer
    this.wss = null
    this.httpServer = null
    this.heartbeat.stop()
    this.heartbeatConnections.clear()

    if (wss) {
      for (const client of wss.clients) {
        // Why: a half-open mobile socket may never answer a close frame, which keeps httpServer.close pending.
        client.terminate()
      }
      wss.close()
    }

    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
  }

  // Why: WS connections are long-lived and multiplex many RPCs by `id`; auth and dispatch are delegated to the message handler.
  private handleConnection(ws: WebSocket): void {
    let finalized = false
    const onPong = (): void => {
      this.heartbeat.noteAlive(ws)
    }
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      // Why: any inbound frame counts as proof of life, so an actively-talking client isn't reaped mid-request.
      this.heartbeat.noteAlive(ws)
      const msg =
        typeof data === 'string'
          ? data
          : isBinary
            ? new Uint8Array(data as Buffer)
            : data.toString()
      this.messageHandler?.(
        msg,
        (response) => {
          // Why: mobile clients disconnect often; guard the write so we don't throw on a dead socket.
          if (ws.readyState === ws.OPEN) {
            ws.send(response)
          }
        },
        ws
      )
    }
    const onError = (): void => {
      // Why: close isn't guaranteed after every error path; finalize here too so pre-auth E2EE state and connection ids can't leak.
      finalizeConnection()
      ws.close()
    }
    const finalizeConnection = (): void => {
      if (finalized) {
        return
      }
      finalized = true
      ws.off('pong', onPong)
      ws.off('message', onMessage)
      ws.off('close', finalizeConnection)
      ws.off('error', onError)
      this.clearPreAuthTimer(ws)
      this.heartbeatConnections.delete(ws)
      if (this.heartbeatConnections.size === 0) {
        this.heartbeat.stop()
      }
      const clientId = this.wsClientIds.get(ws) ?? null
      this.wsClientIds.delete(ws)
      const hasOtherConnections =
        clientId !== null && Array.from(this.wsClientIds.values()).includes(clientId)
      this.connectionCloseHandler?.(clientId, ws, hasOtherConnections)
    }

    // Why: seed before arming so a fresh first socket survives its initial sweep.
    this.heartbeatConnections.add(ws)
    this.heartbeat.noteAlive(ws)
    if (this.heartbeatConnections.size === 1) {
      this.heartbeat.start(() => this.wss?.clients ?? [])
    }

    const preAuthTimer = setTimeout(() => {
      if (!this.wsClientIds.has(ws)) {
        // Why: a silent auto-ponging client would otherwise hold a finite mobile slot forever without starting the E2EE handshake.
        ws.terminate()
      }
    }, this.preAuthTimeoutMs)
    if (typeof preAuthTimer.unref === 'function') {
      preAuthTimer.unref()
    }
    this.preAuthTimers.set(ws, preAuthTimer)

    ws.on('pong', onPong)
    ws.on('message', onMessage)

    // Why: clean up connection-scoped state (e.g. mobile-fit overrides) so a dropped phone doesn't leave orphaned phone-fit on desktop.
    ws.on('close', finalizeConnection)
    ws.on('error', onError)
  }

  private clearPreAuthTimer(ws: WebSocket): void {
    const timer = this.preAuthTimers.get(ws)
    if (timer) {
      clearTimeout(timer)
      this.preAuthTimers.delete(ws)
    }
  }
}

function isEAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}
