import type WebSocket from 'ws'

export const RELAY_WEBSOCKET_FORCE_CLOSE_MS = 1_000
const forceCloseTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

// Write close before any wait so responsive peers receive rejection before FIN; the 1s termination bound frees admission.
// Backpressure can still drop queued close/relay-moved frames, even for reading peers: delivery is best effort.
export function closeRelayWebSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.CLOSED) return
  if (!forceCloseTimers.has(socket)) {
    const timer = setTimeout(() => {
      forceCloseTimers.delete(socket)
      if (socket.readyState !== socket.CLOSED) socket.terminate()
    }, RELAY_WEBSOCKET_FORCE_CLOSE_MS)
    timer.unref()
    forceCloseTimers.set(socket, timer)
    socket.once('close', () => {
      const pending = forceCloseTimers.get(socket)
      if (pending) clearTimeout(pending)
      forceCloseTimers.delete(socket)
    })
  }
  if (socket.readyState === socket.OPEN) socket.close(code, reason)
}
