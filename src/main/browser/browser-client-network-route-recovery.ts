import {
  BrowserHostReconnectDelay,
  nextBrowserHostReconnectDelay
} from './browser-host-lease-reconnect-delay'

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
          addresses[index] = await reconnectRoute({
            ...options,
            route: options.routes[index]!,
            deadline
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

async function reconnectRoute(options: {
  route: RecoverableRoute
  signal: AbortSignal
  deadline: number
  retryDelayMs: number
  browserHostClientId: string
}): Promise<{ host: string; port: number }> {
  const delay = new BrowserHostReconnectDelay()
  const abort = (): void => delay.release()
  options.signal.addEventListener('abort', abort, { once: true })
  let attempt = 0
  let lastError: unknown
  try {
    while (!options.signal.aborted) {
      try {
        return await options.route.route.reconnect()
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
          browserHostClientId: `${options.browserHostClientId}:${options.route.key}`
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
