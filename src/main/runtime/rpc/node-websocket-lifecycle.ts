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

// Why: WS connections are long-lived and multiplex many RPCs by `id`; auth and dispatch are delegated to the message handler.
export function attachNodeWebSocketLifecycle(args: {
  ws: WebSocket
  heartbeat: RemoteRuntimeServerHeartbeat
  preAuthTimeoutMs: number
  preAuthTimers: WeakMap<WebSocket, ReturnType<typeof setTimeout>>
  clientIds: Map<WebSocket, string>
  heartbeatConnections: Set<WebSocket>
  // Why: read lazily so a handler registered after start still reaches sockets accepted earlier.
  getMessageHandler: () => WebSocketMessageHandler | null
  getConnectionCloseHandler: () => WebSocketConnectionCloseHandler | null
}): void {
  const { ws } = args
  let finalized = false
  const onPong = (): void => args.heartbeat.noteAlive(ws)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    // Why: any inbound frame counts as proof of life, so an actively-talking client isn't reaped mid-request.
    args.heartbeat.noteAlive(ws)
    const message =
      typeof data === 'string' ? data : isBinary ? toBinaryPayload(data) : data.toString()
    args.getMessageHandler()?.(
      message,
      (response) => {
        // Why: mobile clients disconnect often; guard the write so we don't throw on a dead socket.
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
    // Why: close isn't guaranteed after every error path; finalize here too so pre-auth E2EE state and connection ids can't leak.
    finalize()
    ws.close()
  }
  const preAuthTimer = setTimeout(() => {
    if (!args.clientIds.has(ws)) {
      // Why: a silent auto-ponging client would otherwise hold a finite mobile slot forever without starting the E2EE handshake.
      ws.terminate()
    }
  }, args.preAuthTimeoutMs)
  preAuthTimer.unref?.()
  args.preAuthTimers.set(ws, preAuthTimer)
  ws.on('pong', onPong)
  ws.on('message', onMessage)
  // Why: clean up connection-scoped state (e.g. mobile-fit overrides) so a dropped phone doesn't leave orphaned phone-fit on desktop.
  ws.on('close', finalize)
  ws.on('error', onError)
  // Why: install lifecycle ownership before periodic heartbeat ticks can observe this socket.
  args.heartbeatConnections.add(ws)
  args.heartbeat.noteAlive(ws)
  if (args.heartbeatConnections.size === 1) {
    // Unauthenticated sockets are protected by the pre-auth timeout; heartbeat probes begin only
    // after E2EE binds a client id, avoiding control frames during the handshake.
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
      // Why: a half-open mobile socket may never answer a close frame, which keeps httpServer.close pending.
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
      // Why: idle keep-alive static-web connections would otherwise hold close() open.
      httpServer.closeAllConnections()
    })
  }
}

// Why: force-terminate soon after the 1013 close since a half-open phone may never ack and would hold the descriptor past the WS cap; the 'error' listener absorbs a reset while closing.
export function rejectNodeWebSocketOverCapacity(ws: WebSocket): void {
  ws.on('error', () => {})
  ws.close(1013, 'Maximum connections reached')
  const terminateTimer = setTimeout(() => ws.terminate(), 1_000)
  terminateTimer.unref?.()
  ws.once('close', () => clearTimeout(terminateTimer))
}
