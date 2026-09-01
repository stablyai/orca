import type { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { WebSocketServer } from 'ws'
import type { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

type WebSocketMessagePayload = string | Uint8Array<ArrayBufferLike>
export type WebSocketMessageHandler = {
  bivarianceHack(
    msg: WebSocketMessagePayload,
    reply: (response: string) => void,
    ws: WebSocket
  ): void
}['bivarianceHack']

export function attachNodeWebSocketLifecycle(args: {
  ws: WebSocket
  heartbeat: RemoteRuntimeServerHeartbeat
  preAuthTimeoutMs: number
  preAuthTimers: WeakMap<object, ReturnType<typeof setTimeout>>
  clientIds: Map<WebSocket, string>
  heartbeatConnections: Set<WebSocket>
  getClients: () => Iterable<WebSocket>
  messageHandler: WebSocketMessageHandler | null
  connectionCloseHandler:
    | ((clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void)
    | null
}): void {
  const { ws } = args
  let finalized = false
  const onPong = (): void => args.heartbeat.noteAlive(ws)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    args.heartbeat.noteAlive(ws)
    const message =
      typeof data === 'string' ? data : isBinary ? new Uint8Array(data as Buffer) : data.toString()
    args.messageHandler?.(
      message,
      (response) => {
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
    clearPreAuthTimer(ws, args.preAuthTimers)
    args.heartbeatConnections.delete(ws)
    if (args.heartbeatConnections.size === 0) {
      args.heartbeat.stop()
    }
    const clientId = args.clientIds.get(ws) ?? null
    args.clientIds.delete(ws)
    const hasOtherConnections =
      clientId !== null && Array.from(args.clientIds.values()).includes(clientId)
    args.connectionCloseHandler?.(clientId, ws, hasOtherConnections)
  }
  const onError = (): void => {
    finalize()
    ws.close()
  }
  const preAuthTimer = setTimeout(() => {
    if (!args.clientIds.has(ws)) {
      ws.terminate()
    }
  }, args.preAuthTimeoutMs)
  preAuthTimer.unref?.()
  args.preAuthTimers.set(ws, preAuthTimer)
  ws.on('pong', onPong)
  ws.on('message', onMessage)
  ws.on('close', finalize)
  ws.on('error', onError)
  args.heartbeatConnections.add(ws)
  args.heartbeat.noteAlive(ws)
  if (args.heartbeatConnections.size === 1) {
    args.heartbeat.start(args.getClients)
  }
}

function clearPreAuthTimer(
  ws: object,
  preAuthTimers: WeakMap<object, ReturnType<typeof setTimeout>>
): void {
  const timer = preAuthTimers.get(ws)
  if (timer) {
    clearTimeout(timer)
    preAuthTimers.delete(ws)
  }
}

export async function stopNodeWebSocketTransport(args: {
  wss: WebSocketServer | null
  httpServer: HttpServer | null
  heartbeat: RemoteRuntimeServerHeartbeat
  heartbeatConnections: Set<WebSocket>
}): Promise<void> {
  args.heartbeat.stop()
  args.heartbeatConnections.clear()
  if (args.wss) {
    for (const client of args.wss.clients) {
      client.terminate()
    }
    args.wss.close()
  }
  if (args.httpServer) {
    await new Promise<void>((resolve, reject) => {
      args.httpServer?.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}

export function rejectNodeWebSocketOverCapacity(ws: WebSocket): void {
  ws.on('error', () => {})
  ws.close(1013, 'Maximum connections reached')
  const terminateTimer = setTimeout(() => ws.terminate(), 1_000)
  terminateTimer.unref?.()
  ws.once('close', () => clearTimeout(terminateTimer))
}
