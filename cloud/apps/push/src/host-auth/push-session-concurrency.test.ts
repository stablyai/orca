import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryPushDatabase, openPushDatabase } from '../database/push-database.js'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'
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

describe.skipIf(!process.env.ORCA_PUSH_TEST_DATABASE_URL)('PostgreSQL push sessions', () => {
  it('leaves exactly one live token after concurrent creates', async () => {
    await concurrentSessions(
      await openPushDatabase({
        databaseUrl: process.env.ORCA_PUSH_TEST_DATABASE_URL!,
        dataDir: tmpdir()
      })
    )
  })
})
