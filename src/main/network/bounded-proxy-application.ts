const PROXY_APPLICATION_RETRY_DELAYS_MS = [0, 100] as const

function waitForRetry(delayMs: number): Promise<void> {
  return delayMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMs))
}

export async function runBoundedProxyApplication<T>(apply: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= PROXY_APPLICATION_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await waitForRetry(PROXY_APPLICATION_RETRY_DELAYS_MS[attempt - 1])
    }
    try {
      return await apply()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
