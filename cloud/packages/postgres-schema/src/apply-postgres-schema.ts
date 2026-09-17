import { catalogObjectPresence, type SchemaCatalogQuery } from './catalog-object-precheck.js'
import {
  requireSchemaLockTarget,
  sqlWithoutComments,
  type SchemaLockTarget
} from './schema-lock-target.js'

const RETRYABLE_SCHEMA_CODES = new Set(['57014'])
const LOCK_NOT_AVAILABLE = '55P03'
const DEFAULT_RETRY_DEADLINE_MS = 30_000
const RETRY_BASE_DELAY_MS = 250
const RETRY_MAX_DELAY_MS = 2_000
const DEFAULT_EVENT_PREFIX = 'orca_relay_postgres_schema'

export type SchemaStartupOptions = {
  // Enables the catalog pre-check. Without it every lock-taking statement is sent as before.
  catalogQuery?: SchemaCatalogQuery
  eventPrefix?: string
  now?: () => number
  random?: () => number
  retryDeadlineMs?: number
  // Only for a caller with no catalog pre-check, where a lock timeout still says nothing about
  // whether the object exists.
  retryLockTimeout?: boolean
  wait?: (delayMs: number) => Promise<void>
}

export type SchemaApplySummary = { ran: number; skipped: number }

function retryDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  return Math.ceil(ceiling * (0.5 + random() * 0.5))
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

const CREATE_TABLE_IF_NOT_EXISTS = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i
const CREATE_INDEX_IF_NOT_EXISTS = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i
const ALTER_TABLE_ADD_CONSTRAINT = /^ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\b/i

// `IF NOT EXISTS` only checks the name before the catalog inserts, so the loser of a concurrent
// CREATE can fail on the catalog unique index (23505) or, when the winner has already committed by
// the time the loser reaches TypeCreate/heap_create_with_catalog, on the name check those routines
// repeat (42710 duplicate type, 42P07 duplicate relation). Each is a no-op on the next attempt.
function concurrentCreateCollision(
  value: { code?: unknown; constraint?: unknown },
  sql: string
): boolean {
  if (CREATE_TABLE_IF_NOT_EXISTS.test(sql)) {
    return (
      (value.code === '23505' && value.constraint === 'pg_type_typname_nsp_index') ||
      value.code === '42710' ||
      value.code === '42P07'
    )
  }
  if (CREATE_INDEX_IF_NOT_EXISTS.test(sql)) {
    return (
      (value.code === '23505' && value.constraint === 'pg_class_relname_nsp_index') ||
      value.code === '42P07'
    )
  }
  return false
}

function constraintAlreadyApplied(error: unknown, sql: string): boolean {
  return (
    ALTER_TABLE_ADD_CONSTRAINT.test(sql) && (error as { code?: unknown } | null)?.code === '42710'
  )
}

function retryableSchemaError(error: unknown, sql: string): boolean {
  const value = (error as { code?: unknown; constraint?: unknown } | null) ?? {}
  return RETRYABLE_SCHEMA_CODES.has(String(value.code)) || concurrentCreateCollision(value, sql)
}

// Evaluated immediately before each statement, so a pre-check still sees the objects the statements
// ahead of it created in this same boot.
async function nothingToDo(
  target: SchemaLockTarget | undefined,
  options: SchemaStartupOptions,
  eventPrefix: string
): Promise<boolean> {
  const catalogQuery = options.catalogQuery
  if (!catalogQuery || !target) return false
  const presence = await catalogObjectPresence(catalogQuery, target)
  if (presence.present !== (target.skipWhen === 'present')) return false
  console.log(
    JSON.stringify({
      event: `${eventPrefix}_object_${target.skipWhen}`,
      kind: target.kind,
      table: target.table,
      name: target.name,
      indisvalid: presence.indisvalid
    })
  )
  return true
}

export async function applyPostgresSchema(
  statements: string[],
  query: (statement: string) => Promise<unknown>,
  options: SchemaStartupOptions = {}
): Promise<SchemaApplySummary> {
  const eventPrefix = options.eventPrefix ?? DEFAULT_EVENT_PREFIX
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const pause = options.wait ?? wait
  const deadlineAt = now() + (options.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS)
  const summary: SchemaApplySummary = { ran: 0, skipped: 0 }

  for (const statement of statements) {
    // Throws when an index or column statement's target cannot be read, rather than sending it
    // unchecked into the lock queue.
    const target = requireSchemaLockTarget(statement)
    if (await nothingToDo(target, options, eventPrefix)) {
      summary.skipped += 1
      continue
    }
    const sql = sqlWithoutComments(statement)
    let attempt = 1
    while (true) {
      try {
        await query(statement)
        summary.ran += 1
        break
      } catch (error) {
        if (constraintAlreadyApplied(error, sql)) {
          summary.skipped += 1
          break
        }
        const code = String((error as { code?: unknown } | null)?.code)
        // With the pre-check ahead of it a lock timeout means the object is genuinely missing and
        // this boot lost the queue. Relation locks are granted in queue order, so each retry parks
        // every writer behind it again for another timeout. Fail once, loudly.
        if (code === LOCK_NOT_AVAILABLE && !options.retryLockTimeout) {
          console.error(
            JSON.stringify({
              event: `${eventPrefix}_lock_timeout`,
              code,
              statement: sql.split('\n')[0],
              detail: 'boot-time DDL could not take its lock; retrying would requeue every writer'
            })
          )
          throw error
        }
        // The object was created between the pre-check and this statement. Re-asking the catalog
        // is the cheap answer; retrying the CREATE INDEX would take SHARE on the table again for
        // an object that is already there.
        if (
          concurrentCreateCollision((error as { code?: unknown; constraint?: unknown }) ?? {}, sql) &&
          (await nothingToDo(target, options, eventPrefix))
        ) {
          summary.skipped += 1
          break
        }
        const remainingMs = deadlineAt - now()
        const retryable =
          retryableSchemaError(error, sql) ||
          (code === LOCK_NOT_AVAILABLE && options.retryLockTimeout === true)
        if (!retryable || remainingMs <= 0) {
          if (retryable) {
            console.warn(
              JSON.stringify({ event: `${eventPrefix}_retry_exhausted`, code, attempts: attempt })
            )
          }
          throw error
        }
        const delayMs = Math.min(remainingMs, retryDelayMs(attempt, random))
        console.warn(JSON.stringify({ event: `${eventPrefix}_retry`, code, attempt, delayMs }))
        await pause(delayMs)
        attempt += 1
      }
    }
  }
  console.log(JSON.stringify({ event: `${eventPrefix}_applied`, ...summary }))
  return summary
}
