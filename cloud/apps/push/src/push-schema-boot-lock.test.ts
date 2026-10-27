import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { openPushDatabase } from './push-database.js'
import { durablePushTestDatabaseUrl } from './durable-push-store.test-fixture.js'

const QUEUE_INDEXES = ['push_batches_pending_device']
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Push applies its schema with retryLockTimeout, so a lock timeout is retried, never deferred:
// the new revision either boots with every index or does not boot at all.
it.skipIf(!durablePushTestDatabaseUrl)(
  'creates the queue index after waiting out a writer that holds the table',
  async () => {
    const admin = new pg.Client({ connectionString: durablePushTestDatabaseUrl })
    await admin.connect()
    const schema = `boot_${randomUUID().replaceAll('-', '')}`
    cleanups.push(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.end()
    })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(durablePushTestDatabaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    await (await openPushDatabase({ databaseUrl: url.toString(), dataDir: '' })).close()
    await admin.query(
      `DROP INDEX ${QUEUE_INDEXES.map((name) => `${schema}.${name}`).join(', ')}`
    )

    const writer = new pg.Client({ connectionString: url.toString() })
    await writer.connect()
    cleanups.push(() => writer.end())
    await writer.query('BEGIN')
    await writer.query('LOCK TABLE push_delivery_batches IN ROW EXCLUSIVE MODE')
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: string) => warnings.push(line))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const held = setTimeout(() => void writer.query('COMMIT'), 2_500)
    cleanups.push(async () => clearTimeout(held))

    const booted = await openPushDatabase({ databaseUrl: url.toString(), dataDir: '' })
    await booted.close()
    const { rows } = await admin.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2) ORDER BY 1',
      [schema, QUEUE_INDEXES]
    )
    expect(rows.map((row) => row.indexname)).toEqual(QUEUE_INDEXES)
    const events = warnings.map((line) => JSON.parse(line).event)
    expect(events).toContain('orca_push_postgres_schema_retry')
    expect(events).not.toContain('orca_push_postgres_schema_object_deferred')
  }
)
