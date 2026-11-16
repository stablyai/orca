import type { ProxySession } from './electron-default-proxy-session'

const connectionsBySession = new WeakMap<ProxySession, Set<() => void>>()

export function trackProxySessionConnection(session: ProxySession, close: () => void): () => void {
  let connections = connectionsBySession.get(session)
  if (!connections) {
    connections = new Set()
    connectionsBySession.set(session, connections)
  }
  connections.add(close)
  return () => {
    connections.delete(close)
  }
}

export function closeProxySessionConnections(session: ProxySession): void {
  const connections = connectionsBySession.get(session)
  if (!connections) {
    return
  }
  for (const close of connections) {
    close()
  }
  connections.clear()
}
