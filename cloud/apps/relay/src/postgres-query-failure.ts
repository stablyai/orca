type QueryFailurePhase = 'acquire' | 'execute'

const ERROR_CODES = new Set([
  '57014',
  '55P03',
  '40P01',
  '40001',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE'
])

export function reportPostgresQueryFailure(input: {
  error: unknown
  phase: QueryFailurePhase
  sql: string
  elapsedMs: number
  pool: { totalCount: number; idleCount: number; waitingCount: number }
}): void {
  // Emit only bounded categories: error messages and SQL can contain credentials or identities.
  try {
    const error = input.error as { code?: unknown; message?: unknown } | null
    const code =
      typeof error?.code === 'string' && ERROR_CODES.has(error.code) ? error.code : 'unknown'
    const connectionTimeout =
      typeof error?.message === 'string' &&
      error.message.includes('timeout exceeded when trying to connect')
    console.warn(
      JSON.stringify({
        event: 'orca_relay_postgres_query_failed',
        phase: input.phase,
        operation: /^\s*WITH\s+assignment_state\s+AS\s+MATERIALIZED\b/i.test(input.sql)
          ? 'control-renewal'
          : 'other',
        code,
        connectionTimeout,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
        poolTotal: input.pool.totalCount,
        poolIdle: input.pool.idleCount,
        poolWaiting: input.pool.waitingCount
      })
    )
  } catch {
    // Diagnostics must not replace the original database failure.
  }
}
