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
    try {
      let messagesForCommit = 0
      const result = await database.transaction(async (transaction) => {
        await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, ['a', 'x'])
        const before = sent.mock.calls.length
        const committed = await commitWithFinalWrite(
          transaction,
          counterUpdate,
          counterParams("it's", 1)
        )
        messagesForCommit = sent.mock.calls.length - before
        return committed
      })
      const texts = sent.mock.calls.map(([text]) => String(text))
      expect(result).toBe(true)
      expect(messagesForCommit).toBe(1)
      expect(texts.filter((text) => text === 'COMMIT')).toEqual([])
      expect(texts.at(-1)).toMatch(/; COMMIT$/)
      expect(await counter("it's")).toBe(1)
      expect(await logged()).toBe(1)
    } finally {
      sent.mockRestore()
    }
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

  it('retries a deadlock raised by the fused message and commits once', async () => {
    const sequence = `${table}_retry_sequence`
    const trigger = `${table}_retry_trigger`
    const fn = `${table}_retry`
    let attempts = 0
    try {
      await admin.query(`CREATE SEQUENCE ${sequence}`)
      await admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('${sequence}') = 1 THEN
            RAISE EXCEPTION 'injected fused deadlock' USING ERRCODE = '40P01';
          END IF;
          RETURN NEW;
        END $$`)
      await admin.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
      const result = await database.transaction(
        async (transaction) => {
          attempts += 1
          await transaction.query(`INSERT INTO ${table}_log (id, note) VALUES (?, ?)`, [
            'a',
            'retry'
          ])
          return await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))
        },
        { reportRetries: false }
      )
      expect(result).toBe(true)
      expect(attempts).toBe(2)
      expect(await counter('a')).toBe(1)
      expect(await logged()).toBe(1)
      expect(
        Number((await admin.query(`SELECT last_value FROM ${sequence}`)).rows[0].last_value)
      ).toBe(2)
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`)
      await admin.query(`DROP FUNCTION IF EXISTS ${fn}()`)
      await admin.query(`DROP SEQUENCE IF EXISTS ${sequence}`)
    }
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
    let pid: number | undefined
    let rejected: Promise<void> | undefined
    const blocker = new pg.Client({ connectionString: databaseUrl })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT n FROM ${table} WHERE id = 'a' FOR UPDATE`)
      const ours = database.transaction(async (transaction) => {
        attempts += 1
        pid = Number((await transaction.query('SELECT pg_backend_pid() AS pid'))[0]!.pid)
        return await commitWithFinalWrite(transaction, counterUpdate, counterParams('a', 1))
      })
      rejected = expect(ours).rejects.toMatchObject({ code: '57P01' })
      await expect
        .poll(
          async () => {
            if (pid === undefined) {
              return false
            }
            const rows = await admin.query(
              `SELECT 1 FROM pg_stat_activity
          WHERE pid = $1 AND wait_event_type = 'Lock' AND query LIKE '%; COMMIT'`,
              [pid]
            )
            return rows.rowCount === 1
          },
          { timeout: 2_000, interval: 10 }
        )
        .toBe(true)
      expect(
        (await admin.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows
      ).toEqual([{ terminated: true }])
      await rejected
    } finally {
      try {
        await blocker.query('ROLLBACK')
      } finally {
        await blocker.end()
        await rejected
      }
    }
    expect(attempts).toBe(1)
    expect(await counter('a')).toBe(0)
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
