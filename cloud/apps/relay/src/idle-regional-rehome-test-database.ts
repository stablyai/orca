import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { openInMemoryRelayDatabase, openRelayDatabase, type RelayDatabase } from './database.js'

export async function openIdleRehomeTestDatabase(): Promise<RelayDatabase> {
  const configured = process.env.ORCA_IDLE_REHOME_POSTGRES_URL
  if (!configured) return openInMemoryRelayDatabase()
  const url = new URL(configured)
  if (url.port !== '55440' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('idle_rehome_tests_require_local_postgres_55440')
  }
  const schema = `idle_rehome_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: configured })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const database = await openRelayDatabase({ databaseUrl: url.toString(), dataDir: '' })
    const close = database.close.bind(database)
    database.close = async () => {
      try {
        await close()
      } finally {
        try {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`)
        } finally {
          await admin.end()
        }
      }
    }
    return database
  } catch (error) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await admin.end()
    }
    throw error
  }
}
