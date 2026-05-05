// Why: the WebSocket transport enables mobile clients to connect to the Orca
// runtime over the local network. When TLS cert/key are provided it uses wss://
// to prevent passive sniffing; otherwise it falls back to plain ws://. Per-device
// tokens (validated by the message handler in OrcaRuntimeRpcServer) provide auth
// regardless of transport encryption.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https'
import { createServer as createHttpServer, type Server as HttpServer } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'

const MAX_WS_MESSAGE_BYTES = 1024 * 1024
const MAX_WS_CONNECTIONS = 32

export type WebSocketTransportOptions = {
  host: string
  port: number
  tlsCert?: string
  tlsKey?: string
}

export class WebSocketTransport implements RpcTransport {
  private readonly host: string
  private readonly port: number
  private readonly tlsCert: string | undefined
  private readonly tlsKey: string | undefined
  private httpServer: HttpsServer | HttpServer | null = null
  private wss: WebSocketServer | null = null
  private messageHandler:
    | ((msg: string, reply: (response: string) => void, ws: WebSocket) => void)
    | null = null
  private connectionCloseHandler:
    | ((clientId: string, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null = null
  // Why: maps each WebSocket to the clientId (deviceToken) that authenticated it,
  // so ws.on('close') can notify the runtime which mobile client disconnected.
  private wsClientIds = new Map<WebSocket, string>()

  constructor({ host, port, tlsCert, tlsKey }: WebSocketTransportOptions) {
    this.host = host
    this.port = port
    this.tlsCert = tlsCert
    this.tlsKey = tlsKey
  }

  onMessage(
    handler: (msg: string, reply: (response: string) => void, ws: WebSocket) => void
  ): void {
    this.messageHandler = handler
  }

  // Why: handlers receive the closing `ws` so per-connection state can be
  // targeted exactly (one paired device may hold multiple concurrent sockets,
  // e.g. host screen + accounts screen). `hasOtherConnections` tells the
  // runtime whether other sockets for the same deviceToken are still alive,
  // so client-scoped teardown (mobile-fit overrides, etc.) only fires on the
  // last disconnect.
  onConnectionClose(
    handler: (clientId: string, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void {
    this.connectionCloseHandler = handler
  }

  setClientId(ws: WebSocket, clientId: string): void {
    this.wsClientIds.set(ws, clientId)
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

    // Why: when the preferred port is occupied (e.g. another Orca instance is
    // already running), fall back to an OS-assigned port so mobile pairing
    // still works. The QR code reads resolvedPort after start, so it will
    // advertise the correct port regardless.
    let port = this.port
    try {
      await this.tryListen(port)
    } catch (error: unknown) {
      if (isEAddressInUse(error) && port !== 0) {
        console.warn(`[ws-transport] Port ${port} is in use, falling back to OS-assigned port`)
        port = 0
        await this.tryListen(port)
      } else {
        throw error
      }
    }
  }

  private createHttpServer(): HttpServer | HttpsServer {
    return this.tlsCert && this.tlsKey
      ? createHttpsServer({ cert: this.tlsCert, key: this.tlsKey })
      : createHttpServer()
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

    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: MAX_WS_MESSAGE_BYTES
    })

    wss.on('connection', (ws) => {
      if (wss.clients.size > MAX_WS_CONNECTIONS) {
        ws.close(1013, 'Maximum connections reached')
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

    if (wss) {
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down')
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
    ws.on('message', (data) => {
      const msg = typeof data === 'string' ? data : data.toString('utf-8')
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
    })

    // Why: mobile clients disconnect when the phone locks, loses wifi, or
    // backgrounds the app. The runtime must clean up connection-scoped state
    // (e.g., mobile-fit overrides) to prevent orphaned phone-fit on desktop.
    ws.on('close', () => {
      const clientId = this.wsClientIds.get(ws)
      this.wsClientIds.delete(ws)
      if (clientId) {
        // Why: a paired device may have multiple concurrent sockets open
        // (e.g. one per app screen). Per-client teardown must only fire when
        // the last socket for this token closes — otherwise closing the
        // accounts-screen socket would clobber the host-screen socket's
        // state and strand it in a non-functional state until re-paired.
        const hasOtherConnections = Array.from(this.wsClientIds.values()).includes(clientId)
        this.connectionCloseHandler?.(clientId, ws, hasOtherConnections)
      }
    })

    ws.on('error', () => {
      ws.close()
    })
  }
}

function isEAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}
