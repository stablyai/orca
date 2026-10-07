import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryPushDatabase, openPushDatabase, type PushDatabase } from './push-database.js'
import { PushHostSessionStore } from './host-session-store.js'
const databases: PushDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()))
})

async function concurrentSessions(db: PushDatabase) {
  databases.push(db)
  const host = randomUUID()
  const store = new PushHostSessionStore(db)
  try {
    const sessions = await Promise.all(Array.from({ length: 20 }, () => store.create(host)))
    const decisions = await Promise.all(
      sessions.map((session) => store.resolve(session.sessionToken))
    )
    expect(decisions.filter((decision) => decision.ok)).toHaveLength(1)
    const [row] = await db.query(
      'SELECT COUNT(*) AS count FROM push_sessions WHERE host_fingerprint = ?',
      [host]
    )
    expect(Number(row?.count)).toBe(1)
  } finally {
    await db.query('DELETE FROM push_sessions WHERE host_fingerprint = ?', [host])
  }
}
it('serializes sessions on SQLite', async () => {
  await concurrentSessions(await openInMemoryPushDatabase())
})

it('enforces one session per host directly in the schema', async () => {
  const db = await openInMemoryPushDatabase()
  databases.push(db)
  await db.query('INSERT INTO push_sessions VALUES (?, ?, ?, ?)', ['first', 'host', 100, 1])
  await expect(
    db.query('INSERT INTO push_sessions VALUES (?, ?, ?, ?)', ['second', 'host', 100, 2])
  ).rejects.toThrow()
  expect(await db.query('SELECT token_hash FROM push_sessions')).toEqual([{ token_hash: 'first' }])
})

describe.skipIf(!process.env.ORCA_PUSH_TEST_DATABASE_URL)('PostgreSQL push sessions', () => {
  it('leaves exactly one live token after concurrent creates', async () => {
    await concurrentSessions(
      await openPushDatabase({
        databaseUrl: process.env.ORCA_PUSH_TEST_DATABASE_URL!,
        dataDir: tmpdir()
      })
    )
  })
  it('allows concurrent schema startup', async () => {
    const opened = await Promise.all(
      Array.from({ length: 4 }, () =>
        openPushDatabase({
          databaseUrl: process.env.ORCA_PUSH_TEST_DATABASE_URL!,
          dataDir: tmpdir()
        })
      )
    )
    databases.push(...opened)
    for (const db of opened) expect(await db.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }])
  })
})
