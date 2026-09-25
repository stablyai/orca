import type { RelayDatabase } from './database.js'

export type RelayReadinessFailure =
  | 'jwks_fetch_failed'
  | 'jwks_http_failed'
  | 'jwks_timed_out'
  | 'sql_failed'

export type RelayReadinessDependency = 'jwks' | 'sql'

export type RelayReadinessObservation = {
  ready: boolean
  failure?: RelayReadinessFailure
  // Both dependencies are probed every poll, so both can fail in the same one.
  failures?: RelayReadinessFailure[]
  degraded?: true
  degradedDependencies?: RelayReadinessDependency[]
  jwksLatencyMs: number
  sqlLatencyMs: number
  totalLatencyMs: number
}

export type RelayReadinessGraceEvent = {
  dependency: RelayReadinessDependency
  grace: 'entered' | 'recovered' | 'expired'
  failure?: RelayReadinessFailure
  lastSuccessAgeMs?: number
  graceMs: number
}

export type RelayReadinessProbe = {
  check: () => Promise<boolean>
  degradedDependencies: () => RelayReadinessDependency[]
}

// The token verifier caches keys in process, so a cell keeps verifying tokens right through a JWKS
// outage: the only thing an unreachable JWKS endpoint blocks is a key rotation nobody is running.
export const RELAY_READINESS_JWKS_GRACE_MS = 900_000
// Each cell is its own load balancer backend, so failing readiness never re-routes a host, it only
// makes that hostname unreachable. A host that lands on a SQL-dead cell gets WRONG_CELL and is
// re-placed by the director, and existing control sockets survive a generic Postgres error. Three
// minutes rides a Cloud SQL failover without hiding a per-cell fault for a quarter of an hour.
export const RELAY_READINESS_SQL_GRACE_MS = 180_000
export const RELAY_MAX_READINESS_GRACE_MS = 3_600_000

type RelayReadinessOptions = {
  fetch?: typeof fetch
  timeoutMs?: number
  cacheMs?: number
  jwksGraceMs?: number
  sqlGraceMs?: number
  now?: () => number
  observe?: (observation: RelayReadinessObservation) => void
  observeGrace?: (event: RelayReadinessGraceEvent) => void
}

type DependencySettlement = {
  satisfied: boolean
  degraded: boolean
  event?: RelayReadinessGraceEvent
}

function fetchFailure(error: unknown): RelayReadinessFailure {
  return error instanceof Error && error.name === 'TimeoutError'
    ? 'jwks_timed_out'
    : 'jwks_fetch_failed'
}

function graceTransition(
  degraded: boolean,
  failure: RelayReadinessFailure | undefined
): RelayReadinessGraceEvent['grace'] {
  if (degraded) return 'entered'
  return failure === undefined ? 'recovered' : 'expired'
}

// One dependency's own last-known-good clock; collapsing the two would let a healthy JWKS poll keep
// a dead Postgres inside its window forever.
function createDependencyGrace(dependency: RelayReadinessDependency, graceMs: number) {
  let lastSuccessAt: number | undefined
  let inGrace = false

  return (at: number, failure: RelayReadinessFailure | undefined): DependencySettlement => {
    if (failure === undefined) lastSuccessAt = at
    const lastSuccessAgeMs =
      lastSuccessAt === undefined ? undefined : Math.max(0, at - lastSuccessAt)
    const degraded =
      failure !== undefined && lastSuccessAgeMs !== undefined && lastSuccessAgeMs < graceMs
    const crossed = degraded !== inGrace
    inGrace = degraded
    return {
      satisfied: failure === undefined || degraded,
      degraded,
      ...(crossed
        ? {
            event: {
              dependency,
              grace: graceTransition(degraded, failure),
              ...(failure ? { failure } : {}),
              ...(lastSuccessAgeMs === undefined ? {} : { lastSuccessAgeMs }),
              graceMs
            }
          }
        : {})
    }
  }
}

async function timed<T>(
  now: () => number,
  run: () => Promise<T>
): Promise<{ value: T; latencyMs: number }> {
  const startedAt = now()
  const value = await run()
  return { value, latencyMs: Math.max(0, now() - startedAt) }
}

export function createRelayReadiness(
  database: RelayDatabase,
  jwksUrl: string,
  options: RelayReadinessOptions = {}
): RelayReadinessProbe {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  const cacheMs = options.cacheMs ?? 10_000
  const now = options.now ?? Date.now
  const settleJwks = createDependencyGrace(
    'jwks',
    options.jwksGraceMs ?? RELAY_READINESS_JWKS_GRACE_MS
  )
  const settleSql = createDependencyGrace('sql', options.sqlGraceMs ?? RELAY_READINESS_SQL_GRACE_MS)
  let cachedAt = Number.NEGATIVE_INFINITY
  let cached = false
  let lastObservedReady: boolean | undefined
  let degraded: RelayReadinessDependency[] = []

  const probeJwks = async (): Promise<RelayReadinessFailure | undefined> => {
    try {
      const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(timeoutMs) })
      return response.ok ? undefined : 'jwks_http_failed'
    } catch (error) {
      return fetchFailure(error)
    }
  }

  const probeSql = async (): Promise<RelayReadinessFailure | undefined> => {
    try {
      await database.query('SELECT 1 AS ready')
      return undefined
    } catch {
      // The load balancer only needs the boolean; the safe reason is all that is emitted.
      return 'sql_failed'
    }
  }

  const check = async (): Promise<boolean> => {
    if (now() - cachedAt < cacheMs) return cached
    const startedAt = now()
    const [jwks, sql] = await Promise.all([timed(now, probeJwks), timed(now, probeSql)])
    const completedAt = now()
    const jwksSettlement = settleJwks(completedAt, jwks.value)
    const sqlSettlement = settleSql(completedAt, sql.value)
    const failures = [jwks.value, sql.value].filter((value) => value !== undefined)
    const failure = failures[0]
    degraded = []
    if (jwksSettlement.degraded) degraded.push('jwks')
    if (sqlSettlement.degraded) degraded.push('sql')
    cached = jwksSettlement.satisfied && sqlSettlement.satisfied
    cachedAt = completedAt
    if (failure !== undefined || cached !== lastObservedReady) {
      options.observe?.({
        ready: cached,
        ...(failure ? { failure } : {}),
        ...(failures.length > 1 ? { failures } : {}),
        ...(degraded.length > 0 ? { degraded: true, degradedDependencies: [...degraded] } : {}),
        jwksLatencyMs: jwks.latencyMs,
        sqlLatencyMs: sql.latencyMs,
        totalLatencyMs: Math.max(0, completedAt - startedAt)
      })
    }
    for (const event of [jwksSettlement.event, sqlSettlement.event]) {
      if (event) options.observeGrace?.(event)
    }
    lastObservedReady = cached
    return cached
  }

  return { check, degradedDependencies: () => [...degraded] }
}
