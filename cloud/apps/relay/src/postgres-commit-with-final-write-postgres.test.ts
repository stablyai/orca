import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import {
  commitWithFinalWrite,
  openRelayDatabase,
  type RelayDatabase
} from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const table = 'relay_commit_final_write_test'
const counterUpdate = `UPDATE ${table} SET n = n + ?
  WHERE id = ? AND (? <= 0 OR n + ? <= cap)
  RETURNING id`

function counterParams(id: string, delta: number): unknown[] {
  return [delta, id, delta, delta]
}

// The counter write and COMMIT travel as one simple-query message. These pin the
// outcomes callers rely on: a server error means COMMIT never ran, and only a
// lost connection leaves the outcome unknown.
describePostgres('PostgreSQL counter write committed in the same round trip', () => {
  let database: RelayDatabase
  let other: RelayDatabase
  let admin: pg.Client

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    other = await openRelayDatabase({ databaseUrl, dataDir: '' })
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, n BIGINT NOT NULL, cap BIGINT NOT NULL)`
    )
    await admin.query(
      `CREATE TABLE IF NOT EXISTS ${table}_log (id TEXT NOT NULL, note TEXT NOT NULL)`
    )
  })

  beforeEach(async () => {
    await admin.query(`DELETE FROM ${table}`)
    await admin.query(`DELETE FROM ${table}_log`)
    await admin.query(`INSERT INTO ${table} (id, n, cap) VALUES ('a', 0, 2), ('b', 0, 2), ('it''s', 0, 2)`)
  })

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${table}`)
    await admin.query(`DROP TABLE IF EXISTS ${table}_log`)
    await admin.end()
    await database.close()
    await other.close()
  })

  async function counter(id: string): Promise<number> {
    return Number((await admin.query(`SELECT n FROM ${table} WHERE id = $1`, [id])).rows[0].n)
  }

  async function logged(): Promise<number> {
    return Number((await admin.query(`SELECT count(*) AS c FROM ${table}_log`)).rows[0].c)
  }

  it('commits the earlier statements and the counter together in one message', async () => {
    const sent = vi.spyOn(pg.Client.prototype, 'query')
    let messagesForCommit = 0
    const result = await database.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, ['a', 'x'])
      const before = sent.mock.calls.length
      const committed = await commitWithFinalWrite(transaction, counterUpdate, counterParams("it's", 1))
      messagesForCommit = sent.mock.calls.length - before
      return committed
    })
    const texts = sent.mock.calls.map(([text]) => String(text))
    sent.mockRestore()
    expect(result).toBe(true)
    expect(messagesForCommit).toBe(1)
    expect(texts.filter((text) => text === 'COMMIT')).toEqual([])
    expect(texts.at(-1)).toMatch(/; COMMIT$/)
    expect(await counter("it's")).toBe(1)
    expect(await logged()).toBe(1)
  })

  it('rolls back over cap and lets the caller read the row outside the transaction', async () => {
    await admin.query(`UPDATE ${table} SET n = 2 WHERE id = 'a'`)
    let attempts = 0
    const read = await database.transaction(async (transaction) => {
      attempts += 1
      await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, ['a', 'x'])
      if (await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))) {
        return 'committed'
      }
      // Already rolled back, so this runs outside the aborted transaction.
      const rows = await transaction.query(`SELECT id FROM ${table} WHERE id = ?`, ['a'])
      return rows.length > 0 ? 'over-cap' : 'missing'
    })
    expect(read).toBe('over-cap')
    expect(attempts).toBe(1)
    expect(await counter('a')).toBe(2)
    expect(await logged()).toBe(0)
  })

  it('reports a missing row the same way', async () => {
    const read = await database.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, ['z', 'x'])
      if (await commitWithFinalWrite(transaction, counterUpdate, counterParams('z', -1))) {
        return 'committed'
      }
      const rows = await transaction.query(`SELECT id FROM ${table} WHERE id = ?`, ['z'])
      return rows.length > 0 ? 'over-cap' : 'missing'
    })
    expect(read).toBe('missing')
    expect(await logged()).toBe(0)
  })

  it('retries a deadlock or lock timeout raised by the fused message and commits once', async () => {
    let attempts = 0
    let theirAttempts = 0
    let otherHolds!: () => void
    const otherHolding = new Promise<void>((resolve) => (otherHolds = resolve))
    let ourHold!: () => void
    const weHold = new Promise<void>((resolve) => (ourHold = resolve))
    const theirs = other.transaction(async (transaction) => {
      theirAttempts += 1
      await transaction.query(`UPDATE ${table} SET n = n WHERE id = 'b'`)
      otherHolds()
      await weHold
      // Waits for 'a', which the first attempt below holds: one side deadlocks.
      await transaction.query(`UPDATE ${table} SET n = n WHERE id = 'a'`)
    }, { reportRetries: false })
    const ours = database.transaction(async (transaction) => {
      attempts += 1
      await transaction.query(`UPDATE ${table} SET n = n WHERE id = 'a'`)
      await otherHolding
      ourHold()
      return await commitWithFinalWrite(transaction, counterUpdate, counterParams('b', 1))
    }, { reportRetries: false })
    const [mine, their] = await Promise.allSettled([ours, theirs])
    // Whichever side PostgreSQL picks as the victim retries and then succeeds.
    expect(mine.status).toBe('fulfilled')
    expect(their.status).toBe('fulfilled')
    expect(await counter('b')).toBe(1)
    expect(attempts + theirAttempts).toBeGreaterThanOrEqual(3)
  }, 20_000)

  it('retries a lock timeout raised by the fused message', async () => {
    let attempts = 0
    const blocker = new pg.Client({ connectionString: databaseUrl })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT n FROM ${table} WHERE id = 'a' FOR UPDATE`)
      const ours = database.transaction(async (transaction) => {
        attempts += 1
        if (attempts === 2) await blocker.query('COMMIT')
        return await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))
      }, { reportRetries: false })
      await expect(ours).resolves.toBe(true)
    } finally {
      await blocker.end()
    }
    expect(attempts).toBe(2)
    expect(await counter('a')).toBe(1)
  }, 20_000)

  it('never retries when the connection is lost under the fused message', async () => {
    let attempts = 0
    const blocker = new pg.Client({ connectionString: databaseUrl })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT n FROM ${table} WHERE id = 'a' FOR UPDATE`)
      const ours = database.transaction(async (transaction) => {
        attempts += 1
        const pid = Number((await transaction.query('SELECT pg_backend_pid() AS pid'))[0]!.pid)
        // Ends the backend while the fused message waits on the row lock.
        setTimeout(() => {
          void admin.query('SELECT pg_terminate_backend($1)', [pid])
        }, 200)
        return await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))
      })
      await expect(ours).rejects.toThrow()
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
    }
    expect(attempts).toBe(1)
    expect(await counter('a')).toBe(0)
    // The pool still serves after dropping the dead client.
    await expect(database.query('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }])
  }, 20_000)

  it('refuses a statement after the fused commit', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))
        await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, ['a', 'late'])
      })
    ).rejects.toThrow('postgres_transaction_already_committed')
    expect(await counter('a')).toBe(1)
    expect(await logged()).toBe(0)
  })
})
