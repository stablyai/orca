import type WebSocket from 'ws'

const RELAY_WEBSOCKET_FORCE_CLOSE_MS = 1_000
const forceCloseTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

// Delivering the rejection is best effort, and deliberately so. The close frame carrying the
// code and reason is written before the timer can fire, so a peer reading normally gets its
// rejection ahead of the FIN — that much is asserted in relay-first-frame-close.blackbox.test.ts.
// It is not a delivery guarantee: `ws` writes the frame to the socket, and `terminate()` destroys
// the socket a second later, so under backpressure the frame (and any `relay-moved` message queued
// before it) can still be dropped unsent even though the peer never stopped reading. Bounding the
// close is what keeps a stalled peer from holding admission, and no finite grace makes delivery
// certain. Keep the close write ahead of any new wait added here.
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
