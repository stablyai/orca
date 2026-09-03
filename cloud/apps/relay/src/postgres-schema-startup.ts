const RETRYABLE_SCHEMA_CODES = new Set(['55P03', '57014'])
const DEFAULT_RETRY_DEADLINE_MS = 30_000
const RETRY_BASE_DELAY_MS = 250
const RETRY_MAX_DELAY_MS = 2_000

type SchemaStartupOptions = {
  now?: () => number
  random?: () => number
  retryDeadlineMs?: number
  wait?: (delayMs: number) => Promise<void>
}

function retryDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    RETRY_MAX_DELAY_MS
  )
  return Math.ceil(ceiling * (0.5 + random() * 0.5))
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function retryableSchemaError(error: unknown, statement: string): boolean {
  const value = error as { code?: unknown; constraint?: unknown }
  return (
    RETRYABLE_SCHEMA_CODES.has(String(value.code)) ||
    (value.code === '23505' &&
      ((value.constraint === 'pg_type_typname_nsp_index' &&
        /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(statement)) ||
        (value.constraint === 'pg_class_relname_nsp_index' &&
          /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i.test(statement))))
  )
}

export async function applyPostgresSchema(
  statements: string[],
  query: (statement: string) => Promise<unknown>,
  options: SchemaStartupOptions = {}
): Promise<void> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const pause = options.wait ?? wait
  const deadlineAt = now() + (options.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS)

  for (const statement of statements) {
    let attempt = 1
    while (true) {
      try {
        await query(statement)
        break
      } catch (error) {
        const code = String((error as { code?: unknown }).code)
        const remainingMs = deadlineAt - now()
        const retryable = retryableSchemaError(error, statement)
        if (!retryable || remainingMs <= 0) {
          if (retryable) {
            console.warn(
              JSON.stringify({
                event: 'orca_relay_postgres_schema_retry_exhausted',
                code,
                attempts: attempt
              })
            )
          }
          throw error
        }
        const delayMs = Math.min(remainingMs, retryDelayMs(attempt, random))
        console.warn(
          JSON.stringify({
            event: 'orca_relay_postgres_schema_retry',
            code,
            attempt,
            delayMs
          })
        )
        await pause(delayMs)
        attempt += 1
      }
    }
  }
}
