import type { WebSocket } from 'ws'

export const WS_CLOSE_FLUSH_BOUND_MS = 1_000

// Why: ws queues the close frame behind buffered output, so a backlogged or half-open peer could
// wait indefinitely for it; bound the handshake and then drop the socket.
export function closeWebSocketWithinFlushBound(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === ws.CLOSED) {
    return
  }
  ws.close(code, reason)
  const terminateTimer = setTimeout(() => ws.terminate(), WS_CLOSE_FLUSH_BOUND_MS)
  terminateTimer.unref?.()
  ws.once('close', () => clearTimeout(terminateTimer))
}
