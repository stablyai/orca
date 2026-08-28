import {
  BrowserHostReconnectDelay,
  nextBrowserHostReconnectDelay
} from './browser-host-lease-reconnect-delay'

export type BrowserNetworkRouteAddress = { host: string; port: number }

/**
 * Retries one route's reconnect under jittered backoff until it succeeds, the grace deadline
 * passes, or the caller aborts. Shared so registry-driven recovery and a route recovering its
 * own dead transport retry on identical terms.
 */
export async function retryBrowserNetworkRouteReconnect(options: {
  reconnect: () => Promise<BrowserNetworkRouteAddress>
  signal: AbortSignal
  deadline: number
  retryDelayMs: number
  recoveryKey: string
}): Promise<BrowserNetworkRouteAddress> {
  const delay = new BrowserHostReconnectDelay()
  const abort = (): void => delay.release()
  options.signal.addEventListener('abort', abort, { once: true })
  let attempt = 0
  let lastError: unknown
  try {
    while (!options.signal.aborted) {
      try {
        return await options.reconnect()
      } catch (error) {
        lastError = error
      }
      if (options.signal.aborted) {
        throw new Error('browser_client_network_route_recovery_superseded')
      }
      const remainingMs = options.deadline - Date.now()
      if (remainingMs <= 0) {
        throw lastError
      }
      await delay.wait(
        nextBrowserHostReconnectDelay({
          baseDelayMs: options.retryDelayMs,
          attempt,
          remainingMs,
          browserHostClientId: options.recoveryKey
        })
      )
      attempt += 1
    }
    throw new Error('browser_client_network_route_recovery_superseded')
  } finally {
    options.signal.removeEventListener('abort', abort)
    delay.release()
  }
}
