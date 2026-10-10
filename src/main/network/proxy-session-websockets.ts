import type WebSocket from 'ws'
import type { ProxySession } from './electron-default-proxy-session'

const socketsBySession = new WeakMap<ProxySession, Set<WebSocket>>()

export function trackProxySessionWebSocket(session: ProxySession, socket: WebSocket): void {
  let sockets = socketsBySession.get(session)
  if (!sockets) {
    sockets = new Set()
    socketsBySession.set(session, sockets)
  }
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
}

export function closeProxySessionWebSockets(session: ProxySession): void {
  const sockets = socketsBySession.get(session)
  if (!sockets) {
    return
  }
  for (const socket of sockets) {
    socket.terminate()
  }
  sockets.clear()
}
