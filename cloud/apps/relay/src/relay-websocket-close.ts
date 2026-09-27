import type WebSocket from 'ws'

const RELAY_WEBSOCKET_FORCE_CLOSE_MS = 1_000
const forceCloseTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

// The forced terminate costs the peer nothing it can observe: the close frame carrying the
// code and reason is written before the timer can fire, and TCP delivers those bytes ahead
// of the FIN, so an abandoned peer still reads its rejection. Only a peer that has stopped
// reading entirely can miss it, and no finite grace would reach that peer either. Covered by
// relay-first-frame-close.blackbox.test.ts; keep the close write ahead of any new wait here.
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
