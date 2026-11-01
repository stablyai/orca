import type { Server as HttpServer } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import type { WebSocket, WebSocketServer } from 'ws'
import type { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

type WebSocketMessagePayload = string | Uint8Array<ArrayBufferLike>
export type WebSocketMessageHandler = {
  bivarianceHack(
    msg: WebSocketMessagePayload,
    reply: (response: string) => void,
    ws: WebSocket
  ): void
}['bivarianceHack']

export type WebSocketConnectionCloseHandler = (
  clientId: string | null,
  ws: WebSocket,
  hasOtherConnections: boolean
) => void

// Long-lived sockets multiplex RPC ids; message handlers own auth and dispatch.
export function attachNodeWebSocketLifecycle(args: {
  ws: WebSocket
  heartbeat: RemoteRuntimeServerHeartbeat
  preAuthTimeoutMs: number
  preAuthTimers: WeakMap<WebSocket, ReturnType<typeof setTimeout>>
  clientIds: Map<WebSocket, string>
  heartbeatConnections: Set<WebSocket>
  // Read lazily so handlers registered after startup reach existing sockets.
  getMessageHandler: () => WebSocketMessageHandler | null
  getConnectionCloseHandler: () => WebSocketConnectionCloseHandler | null
}): void {
  const { ws } = args
  let finalized = false
  const onPong = (): void => args.heartbeat.notePong(ws)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    // Every inbound frame proves life, including frames during active requests.
    args.heartbeat.noteAlive(ws)
    const message =
      typeof data === 'string' ? data : isBinary ? toBinaryPayload(data) : data.toString()
    args.getMessageHandler()?.(
      message,
      (response) => {
        // Guard writes because phones often disconnect mid-request.
        if (ws.readyState === ws.OPEN) {
          ws.send(response)
        }
      },
      ws
    )
  }
  const finalize = (): void => {
    if (finalized) {
      return
    }
    finalized = true
    ws.off('pong', onPong)
    ws.off('message', onMessage)
    ws.off('close', finalize)
    ws.off('error', onError)
    clearNodeWebSocketPreAuthTimer(ws, args.preAuthTimers)
    args.heartbeatConnections.delete(ws)
    if (args.heartbeatConnections.size === 0) {
      args.heartbeat.stop()
    }
    const clientId = args.clientIds.get(ws) ?? null
    args.clientIds.delete(ws)
    const hasOtherConnections =
      clientId !== null && Array.from(args.clientIds.values()).includes(clientId)
    args.getConnectionCloseHandler()?.(clientId, ws, hasOtherConnections)
  }
  const onError = (): void => {
    // Error paths may omit close; finalize here too to release pre-auth state and connection ids.
    finalize()
    ws.close()
  }
  const preAuthTimer = setTimeout(() => {
    if (!args.clientIds.has(ws)) {
      // Silent auto-pong clients must not hold finite mobile slots without beginning E2EE.
      ws.terminate()
    }
  }, args.preAuthTimeoutMs)
  preAuthTimer.unref?.()
  args.preAuthTimers.set(ws, preAuthTimer)
  ws.on('pong', onPong)
  ws.on('message', onMessage)
  // Drop connection-owned state so disconnected phones leave no fit overrides.
  ws.on('close', finalize)
  ws.on('error', onError)
  // Install ownership before heartbeat ticks can see this socket.
  args.heartbeatConnections.add(ws)
  args.heartbeat.track(ws)
  args.heartbeat.noteAlive(ws)
  if (args.heartbeatConnections.size === 1) {
    // Pre-auth timeout owns unauthenticated sockets; start probes after E2EE binds identity to avoid handshake control frames.
    args.heartbeat.start(() => args.clientIds.keys())
  }
}

function toBinaryPayload(data: Exclude<WebSocket.RawData, string>): Uint8Array {
  return Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data)
}

export function clearNodeWebSocketPreAuthTimer(
  ws: WebSocket,
  preAuthTimers: WeakMap<WebSocket, ReturnType<typeof setTimeout>>
): void {
  const timer = preAuthTimers.get(ws)
  if (timer) {
    clearTimeout(timer)
    preAuthTimers.delete(ws)
  }
}

export async function stopNodeWebSocketTransport(args: {
  wss: WebSocketServer | null
  httpServer: HttpServer | HttpsServer | null
  heartbeat: RemoteRuntimeServerHeartbeat
  heartbeatConnections: Set<WebSocket>
}): Promise<void> {
  args.heartbeat.stop()
  args.heartbeatConnections.clear()
  if (args.wss) {
    for (const client of args.wss.clients) {
      // Half-open phones may never ACK close, keeping httpServer.close pending.
      client.terminate()
    }
    args.wss.close()
  }
  const httpServer = args.httpServer
  if (httpServer) {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
      // Idle static-web keep-alives can otherwise hold close open.
      httpServer.closeAllConnections()
    })
  }
}

// Terminate soon after 1013: half-open phones may never ACK and retain WS capacity; the error listener handles closing resets.
export function rejectNodeWebSocketOverCapacity(ws: WebSocket): void {
  ws.on('error', () => {})
  ws.close(1013, 'Maximum connections reached')
  const terminateTimer = setTimeout(() => ws.terminate(), 1_000)
  terminateTimer.unref?.()
  ws.once('close', () => clearTimeout(terminateTimer))
}
