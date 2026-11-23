import type { ProxySession } from './electron-default-proxy-session'

const readinessListeners = new Set<(proxySession: ProxySession) => void>()

/** Called synchronously on every readiness change, before a new policy starts applying. */
export function onProxySessionReadinessChanged(
  listener: (proxySession: ProxySession) => void
): () => void {
  readinessListeners.add(listener)
  return () => readinessListeners.delete(listener)
}

export function notifyProxySessionReadinessChanged(proxySession: ProxySession): void {
  for (const listener of readinessListeners) {
    listener(proxySession)
  }
}
