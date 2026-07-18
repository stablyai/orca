// Why: the WebSocket transport enables mobile clients to connect to the Orca
// runtime over the local network. When TLS cert/key are provided it uses wss://
// to prevent passive sniffing; otherwise it falls back to plain ws://. Per-device
// tokens (validated by the message handler in OrcaRuntimeRpcServer) provide auth
// regardless of transport encryption.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'
import { createStaticWebClientHandler } from './static-web-client-handler'

const MAX_WS_MESSAGE_BYTES = 1024 * 1024
// Why: desktop remote-host clients can legitimately hold many concurrent
// streams (session tabs, terminals, file watches, browser streams). Keep the
// cap high enough that leaked/stale streams do not starve short control RPCs.
const MAX_WS_CONNECTIONS = 128
// Why: hard-bound this listener's descriptor use above the WS-upgrade cap.
// Node accepts then drops sockets beyond maxConnections, so raw/pre-upgrade
// clients cannot grow without bound while the existing WS budget remains
// available to legitimate long-lived streams.
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

// Why: mobile clients (iOS/Android) regularly background-suspend their
// sockets without the OS sending a TCP FIN/RST, leaving the server with
// half-open WebSockets that count toward MAX_WS_CONNECTIONS. Without this
// heartbeat the only thing that ever reaps them is the OS's TCP keepalive
// (default macOS: ~2 hours idle + 11 min of probes), which is the
// "connection randomly turns green again after a long delay" symptom.
// Pinging every 15s and terminating any client that hasn't pong'd by the
// next tick collapses that worst case to ~30s. RN/browser WebSocket
// runtimes auto-respond to server pings with pongs at the protocol layer,
// so this works for any client that speaks RFC 6455.
const HEARTBEAT_INTERVAL_MS = 15_000

export type WebSocketTransportOptions = {
  host: string
  port: number
  tlsCert?: string
  tlsKey?: string
  // Why: test-only override. Production uses HEARTBEAT_INTERVAL_MS.
  heartbeatIntervalMs?: number
  // Why: test-only override. Production uses PRE_AUTH_TIMEOUT_MS.
  preAuthTimeoutMs?: number
  // Why: the pairing server can also serve the browser client, so users do
  // not need a second dev/static server once the web bundle is built.
  staticRoot?: string
  // Why: paired mobile devices store the full ws://ip:port endpoint. Once a
  // fallback port has been assigned and persisted, devices paired while it was
  // active point at it, so it must be bound FIRST on later launches — binding
  // the (now free) preferred port instead would strand those pairings
  // (STA-1511). Callers pass the previously assigned fallback port here.
  fallbackPort?: number
  // Why: `orca serve --port <P>` clients dial the pinned port. Prefer that port
  // first (fallback second) so a stale mobile-ws-fallback-port.json cannot
  // silently steal the pin (issue #8535). Default auto/desktop keeps
  // fallback-first for STA-1511 pairing stability.
  preferPinnedPort?: boolean
}

export class WebSocketTransport implements RpcTransport {
  private readonly host: string
  private readonly port: number
  private readonly tlsCert: string | undefined
  private readonly tlsKey: string | undefined
  private readonly heartbeatIntervalMs: number
  private readonly preAuthTimeoutMs: number
  private readonly staticRoot: string | undefined
  private readonly fallbackPort: number | undefined
  private readonly preferPinnedPort: boolean
  private httpServer: HttpsServer | HttpServer | null = null
  private wss: WebSocketServer | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  // Why: tracks whether each socket has pong'd since the last heartbeat
  // sweep. A socket missing from the set when the next sweep fires is
  // assumed dead and terminated.
  private wsAlive = new WeakSet<WebSocket>()
  private messageHandler: WebSocketMessageHandler | null = null
  private connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  // Why: maps each WebSocket to the clientId (deviceToken) that authenticated it,
  // so ws.on('close') can notify the runtime which mobile client disconnected.
  private wsClientIds = new Map<WebSocket, string>()
  private preAuthTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

  constructor({
    host,
    port,
    tlsCert,
    tlsKey,
    heartbeatIntervalMs,
    preAuthTimeoutMs,
    staticRoot,
    fallbackPort,
    preferPinnedPort
  }: WebSocketTransportOptions) {
    this.host = host
    this.port = port
    this.tlsCert = tlsCert
    this.tlsKey = tlsKey
    this.heartbeatIntervalMs = heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.preAuthTimeoutMs = preAuthTimeoutMs ?? PRE_AUTH_TIMEOUT_MS
    this.staticRoot = staticRoot
    this.fallbackPort = fallbackPort
    this.preferPinnedPort = preferPinnedPort === true
  }

  onMessage(handler: WebSocketMessageHandler): void {
    this.messageHandler = handler
  }

  // Why: handlers receive the closing `ws` so per-connection state can be
  // targeted exactly (one paired device may hold multiple concurrent sockets,
  // e.g. host screen + accounts screen). `hasOtherConnections` tells the
  // runtime whether other sockets for the same deviceToken are still alive,
  // so client-scoped teardown (mobile-fit overrides, etc.) only fires on the
  // last disconnect.
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
      // Why: revocation is a security boundary; terminate skips the close
      // handshake so a revoked mobile stream stops immediately.
      ws.terminate()
    }
    return sockets.length
  }

  // Why: when port 0 is passed the OS assigns a random available port. The
  // runtime metadata and mobile QR code need the real port, so callers read
  // it here after start() resolves.
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

    // Why: default order binds a persisted fallback FIRST — devices paired
    // while it was active store ws://ip:<fallback> and would be stranded if a
    // later launch grabbed the (now free) preferred port instead (STA-1511).
    // Explicit serve --port flips the order so the pinned port wins when free
    // (issue #8535); fallback remains a secondary candidate for EADDRINUSE.
    // Without a persisted fallback only the preferred port is tried. On
    // EADDRINUSE each candidate falls through to the next, ending at port 0
    // (OS-assigned) so mobile pairing still works when everything is taken.
    // The QR code reads resolvedPort after start, so it always advertises the
    // port that actually bound.
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
        // Why: a persisted fallback can become unbindable for reasons beyond
        // EADDRINUSE (e.g. Windows reserves dynamic-range ports for Hyper-V
        // after a reboot → EACCES). Any fallback failure must degrade to the
        // next candidate — aborting would disable the transport every launch
        // while the store still names that port. Only preferred-port failures
        // other than EADDRINUSE are fatal.
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

  // Why: the WebSocketServer is attached only after listen succeeds. If we
  // attached it before, the WSS would re-emit the EADDRINUSE error from the
  // httpServer as an uncatchable exception, preventing the fallback from working.
  private async tryListen(port: number): Promise<void> {
    const httpServer = this.createHttpServer()

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, this.host, () => {
        httpServer.off('error', reject)
        resolve()
      })
    })

    // Why: the WS cap applies only after upgrade. A separate TCP cap prevents
    // raw and pre-upgrade sockets from consuming an unbounded descriptor budget.
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
    this.startHeartbeat()
  }

  // Why: over the WS-upgrade cap, request a graceful 1013 close but force the
  // socket down shortly after. A backgrounded/half-open phone may never ack the
  // close frame, so a bare ws.close() can retain the descriptor until the next
  // heartbeat. Under a reconnect flood, shortening that window bounds the
  // number of rejected sockets that can accumulate behind the WS cap. The
  // 'error' listener prevents a reset while closing from becoming unhandled.
  private rejectOverCapacity(ws: WebSocket): void {
    ws.on('error', () => {})
    ws.close(1013, 'Maximum connections reached')
    // Why: give the 1013 close a brief window, then hard-terminate so the
    // descriptor is freed even if the client never acks the close frame.
    const terminateTimer = setTimeout(() => ws.terminate(), 1_000)
    terminateTimer.unref?.()
    ws.once('close', () => clearTimeout(terminateTimer))
  }

  // Why: ping every live socket on a fixed cadence and terminate any that
  // didn't pong since the previous tick. This is the only thing that
  // reliably reaps half-open mobile sockets stranded by background
  // suspension without a TCP FIN. See HEARTBEAT_INTERVAL_MS comment.
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return
    }
    this.heartbeatTimer = setInterval(() => {
      const wss = this.wss
      if (!wss) {
        return
      }
      let reaped = 0
      for (const ws of wss.clients) {
        if (!this.wsAlive.has(ws)) {
          // Why: terminate() (vs close()) skips the close handshake and
          // immediately fires the 'close' event, freeing the slot. close()
          // on an already-dead socket can hang for the OS-level TCP timeout.
          ws.terminate()
          reaped++
          continue
        }
        this.wsAlive.delete(ws)
        try {
          ws.ping()
        } catch {
          // Why: ping() can throw on a socket that's mid-tear-down; the
          // close handler will run regardless, so swallow the throw.
        }
      }
      // Why: steady reaping or a client count riding the cap are early overload
      // signals; surface them without logging on healthy heartbeat ticks.
      if (reaped > 0 || wss.clients.size >= MAX_WS_CONNECTIONS) {
        console.warn(
          `[ws-transport] heartbeat reaped ${reaped}; ${wss.clients.size} tracked sockets`
        )
      }
    }, this.heartbeatIntervalMs)
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref()
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  async stop(): Promise<void> {
    const wss = this.wss
    const httpServer = this.httpServer
    this.wss = null
    this.httpServer = null
    this.stopHeartbeat()

    if (wss) {
      for (const client of wss.clients) {
        // Why: stop() is a teardown path. A half-open mobile socket may never
        // answer a graceful close frame, which keeps httpServer.close pending.
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

  // Why: WebSocket connections are long-lived (unlike Unix socket which is
  // one-per-request). Multiple requests can be multiplexed on the same
  // connection via the RPC `id` field. The transport delegates all auth
  // and dispatch logic to the message handler set by OrcaRuntimeRpcServer.
  private handleConnection(ws: WebSocket): void {
    let finalized = false
    const onPong = (): void => {
      this.wsAlive.add(ws)
    }
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      // Why: any inbound traffic counts as proof of life, not just pongs.
      // RN's WebSocket runtime auto-pongs server pings transparently, but
      // app-level frames also count toward liveness so an actively-talking
      // client doesn't get terminated mid-request.
      this.wsAlive.add(ws)
      const msg =
        typeof data === 'string'
          ? data
          : isBinary
            ? new Uint8Array(data as Buffer)
            : data.toString()
      this.messageHandler?.(
        msg,
        (response) => {
          // Why: mobile clients disconnect frequently (backgrounding, network
          // switch, phone locked). Guard writes to avoid errors on dead sockets.
          if (ws.readyState === ws.OPEN) {
            ws.send(response)
          }
        },
        ws
      )
    }
    const onError = (): void => {
      // Why: close is not guaranteed after every ws error path; finalize here
      // too so pre-auth E2EE channels and connection ids cannot leak.
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
      const clientId = this.wsClientIds.get(ws) ?? null
      this.wsClientIds.delete(ws)
      const hasOtherConnections =
        clientId !== null && Array.from(this.wsClientIds.values()).includes(clientId)
      this.connectionCloseHandler?.(clientId, ws, hasOtherConnections)
    }

    const preAuthTimer = setTimeout(() => {
      if (!this.wsClientIds.has(ws)) {
        // Why: a silent client that only auto-pongs can otherwise occupy one
        // of the finite mobile WebSocket slots forever without ever starting
        // the E2EE handshake.
        ws.terminate()
      }
    }, this.preAuthTimeoutMs)
    if (typeof preAuthTimer.unref === 'function') {
      preAuthTimer.unref()
    }
    this.preAuthTimers.set(ws, preAuthTimer)

    // Why: seed alive=true so the first heartbeat tick after connect doesn't
    // treat a fresh socket as dead. Subsequent pongs (or any inbound traffic)
    // re-arm it.
    this.wsAlive.add(ws)

    ws.on('pong', onPong)
    ws.on('message', onMessage)

    // Why: mobile clients disconnect when the phone locks, loses wifi, or
    // backgrounds the app. The runtime must clean up connection-scoped state
    // (e.g., mobile-fit overrides) to prevent orphaned phone-fit on desktop.
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
