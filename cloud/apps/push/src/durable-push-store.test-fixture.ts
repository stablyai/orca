import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { PushNotification } from '@orca-cloud/push-contract'
import { openInMemoryPushDatabase, openPushDatabase, type PushDatabase } from './push-database.js'
import { DurablePushStore } from './durable-push-store.js'

export const durablePushTestDatabaseUrl =
  process.env.ORCA_PUSH_DURABLE_TEST_POSTGRES_URL ?? process.env.ORCA_PUSH_TEST_DATABASE_URL

const cleanups: (() => Promise<void>)[] = []
export async function cleanupDurablePushFixtures(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
}
export const notification = (seq: number, kind: 'alert' | 'dismiss' = 'alert'): PushNotification => ({
  notificationId: `notification-${seq}`,
  notificationEpoch: 'epoch',
  notificationSeq: seq,
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: '',
  kind
})
// ownDatabase: advisory locks are database-wide, so a test that holds a global key must not share one.
export async function fixture({ ownDatabase = false } = {}) {
  const databaseUrl = durablePushTestDatabaseUrl
  if (databaseUrl && !process.env.CI && new URL(databaseUrl).port !== '55440')
    throw new Error('isolated_postgres_port_required')
  let db: PushDatabase
  if (databaseUrl) {
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const name = `durable_${randomUUID().replaceAll('-', '')}`
    let scoped: PushDatabase | undefined
    cleanups.push(async () => {
      try {
        await scoped?.close()
      } finally {
        try {
          await admin.query(
            ownDatabase ? `DROP DATABASE IF EXISTS ${name}` : `DROP SCHEMA IF EXISTS ${name} CASCADE`
          )
        } finally {
          await admin.end()
        }
      }
    })
    const url = new URL(databaseUrl)
    if (ownDatabase) {
      await admin.query(`CREATE DATABASE ${name}`)
      url.pathname = `/${name}`
    } else {
      await admin.query(`CREATE SCHEMA ${name}`)
      url.searchParams.set('options', `-c search_path=${name}`)
    }
    db = scoped = await openPushDatabase({ databaseUrl: url.toString(), dataDir: '', poolMax: 4 })
  } else {
    db = await openInMemoryPushDatabase()
    cleanups.push(() => db.close())
  }
  let now = 1_000_000
  const clock = () => now
  return {
    db,
    store: new DurablePushStore(db, clock),
    clock,
    advance: (ms: number) => {
      now += ms
    }
  }
}

export const CANDIDATE_SQL = "SELECT * FROM push_delivery_batches WHERE state = 'pending'"
export const DEVICE_HEAD_SQL = 'SELECT (SELECT batch_id'

// Parks the first claim transaction right after the matching statement, locks still held.
export function pauseAfter(database: PushDatabase, prefix = CANDIDATE_SQL) {
  let reached!: () => void
  const atCandidate = new Promise<void>((resolve) => (reached = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let paused = false
  const wrapped: PushDatabase = {
    dialect: database.dialect,
    query: (sql, params) => database.query(sql, params),
    close: () => database.close(),
    lockQuotaScope: (key) => database.lockQuotaScope(key),
    tryLockScope: (key) => database.tryLockScope(key),
    tryLockSharedScope: (key) => database.tryLockSharedScope(key),
    transaction: (run) =>
      database.transaction((tx) =>
        run({
          ...tx,
          dialect: tx.dialect,
          close: () => tx.close(),
          transaction: (inner) => tx.transaction(inner),
          lockQuotaScope: (key) => tx.lockQuotaScope(key),
          tryLockScope: (key) => tx.tryLockScope(key),
          tryLockSharedScope: (key) => tx.tryLockSharedScope(key),
          query: async (sql, params) => {
            const rows = await tx.query(sql, params)
            if (!paused && sql.startsWith(prefix)) {
              paused = true
              reached()
              await released
            }
            return rows
          }
        })
      )
  }
  return { wrapped, atCandidate, release }
}

export async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error('claim_blocked')), ms)))
    ])
  } finally {
    clearTimeout(timer)
  }
}
