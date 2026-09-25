import { retryBrowserNetworkRouteReconnect } from './browser-network-route-reconnect-retry'

const MAX_CONCURRENT_ROUTE_RECONNECTS = 8

type RecoverableRoute = {
  key: string
  route: { reconnect(): Promise<{ host: string; port: number }> }
}

export async function reconnectBrowserClientNetworkRoutes(options: {
  routes: readonly RecoverableRoute[]
  signal: AbortSignal
  graceMs: number
  retryDelayMs: number
  browserHostClientId: string
}): Promise<{ host: string; port: number }[]> {
  const addresses: { host: string; port: number }[] = []
  const failures: unknown[] = []
  const deadline = Date.now() + options.graceMs
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_ROUTE_RECONNECTS, options.routes.length) },
    async () => {
      while (nextIndex < options.routes.length) {
        const index = nextIndex
        nextIndex += 1
        try {
          const route = options.routes[index]!
          addresses[index] = await retryBrowserNetworkRouteReconnect({
            reconnect: () => route.route.reconnect(),
            signal: options.signal,
            deadline,
            retryDelayMs: options.retryDelayMs,
            recoveryKey: `${options.browserHostClientId}:${route.key}`
          })
        } catch (error) {
          failures.push(error)
        }
      }
    }
  )
  await Promise.all(workers)
  if (options.signal.aborted) {
    throw new Error('browser_client_network_route_recovery_superseded')
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client network route reconnect failed')
  }
  return addresses
}
