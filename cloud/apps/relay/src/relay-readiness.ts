import type { RelayDatabase } from './database.js'

export type RelayReadinessFailure =
  | 'jwks_fetch_failed'
  | 'jwks_http_failed'
  | 'jwks_timed_out'
  | 'sql_failed'

export type RelayReadinessObservation = {
  ready: boolean
  failure?: RelayReadinessFailure
  jwksLatencyMs: number
  sqlLatencyMs: number
  totalLatencyMs: number
}

type RelayReadinessOptions = {
  fetch?: typeof fetch
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
  observe?: (observation: RelayReadinessObservation) => void
}

function fetchFailure(error: unknown): RelayReadinessFailure {
  return error instanceof Error && error.name === 'TimeoutError'
    ? 'jwks_timed_out'
    : 'jwks_fetch_failed'
}

export function createRelayReadiness(
  database: RelayDatabase,
  jwksUrl: string,
  options: RelayReadinessOptions = {}
): () => Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  const cacheMs = options.cacheMs ?? 10_000
  const now = options.now ?? Date.now
  let cachedAt = Number.NEGATIVE_INFINITY
  let cached = false
  let lastObservedReady: boolean | undefined

  return async () => {
    if (now() - cachedAt < cacheMs) return cached
    const startedAt = now()
    let jwksCompletedAt = startedAt
    let sqlStartedAt = startedAt
    let failure: RelayReadinessFailure | undefined
    try {
      let response: Response
      try {
        response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        failure = fetchFailure(error)
        throw error
      } finally {
        jwksCompletedAt = now()
      }
      if (!response.ok) {
        failure = 'jwks_http_failed'
        throw new Error(failure)
      }
      sqlStartedAt = now()
      try {
        await database.query('SELECT 1 AS ready')
      } catch (error) {
        failure = 'sql_failed'
        throw error
      }
    } catch {
      // The load balancer only needs the boolean; the safe reason is emitted below.
    }
    const completedAt = now()
    cached = failure === undefined
    cachedAt = completedAt
    if (!cached || cached !== lastObservedReady) {
      options.observe?.({
        ready: cached,
        ...(failure ? { failure } : {}),
        jwksLatencyMs: Math.max(0, jwksCompletedAt - startedAt),
        sqlLatencyMs: failure?.startsWith('jwks_') ? 0 : Math.max(0, completedAt - sqlStartedAt),
        totalLatencyMs: Math.max(0, completedAt - startedAt)
      })
    }
    lastObservedReady = cached
    return cached
  }
}
