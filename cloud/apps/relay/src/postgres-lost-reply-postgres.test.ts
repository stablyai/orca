import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isRelayDatabaseTransientError,
  openRelayDatabase,
  POSTGRES_READ_TIMEOUT_MARGIN_MS,
  type RelayDatabase
} from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const STATEMENT_TIMEOUT_MS = 500
// A short margin keeps the blackhole case fast; production's is 10 s.
const READ_TIMEOUT_MARGIN_MS = 2_000
const READ_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + READ_TIMEOUT_MARGIN_MS
const PROBE_TABLE = 'relay_lost_reply_probe'

// Forwards each connection to PostgreSQL. Once a connection sends a statement naming the
// trigger, the server's replies on that connection are dropped (a reply lost in the network),
// or, with `delayMs`, held that long and then delivered (a whole-VM database stall).
async function blackholeProxy(target: URL, trigger: string, delayMs?: number) {
  const sockets = new Set<Socket>()
  const afterTrigger: Buffer[] = []
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname)
    sockets.add(client)
    sockets.add(upstream)
    let swallowing = false
    client.on('data', (chunk: Buffer) => {
      if (swallowing) afterTrigger.push(chunk)
      else if (chunk.includes(trigger)) swallowing = true
      upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => {
      if (!swallowing) client.write(chunk)
      else if (delayMs !== undefined) setTimeout(() => client.write(chunk), delayMs)
    })
    for (const socket of [client, upstream]) {
      socket.on('error', () => undefined)
      socket.on('close', () => {
        client.destroy()
        upstream.destroy()
      })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('proxy not listening')
  const url = new URL(target)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  return {
    url: url.toString(),
    sentAfterTrigger: () => Buffer.concat(afterTrigger).toString('latin1'),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

describePostgres('a lost PostgreSQL reply against a real server', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function open(
    url: string,
    options: {
      readTimeoutMarginMs?: number
      poolMax?: number
      readTimeoutMarginOverrideMs?: () => number | undefined
    } = {}
  ): Promise<RelayDatabase> {
    const database = await openRelayDatabase({
      databaseUrl: url,
      dataDir: '',
      appliesPostgresSchema: false,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      readTimeoutMarginMs: options.readTimeoutMarginMs ?? READ_TIMEOUT_MARGIN_MS,
      poolMax: options.poolMax,
      readTimeoutMarginOverrideMs: options.readTimeoutMarginOverrideMs
    })
    cleanups.push(async () => await database.close())
    return database
  }

  it('fails within the read timeout, sends nothing after the lost statement, and recovers', async () => {
    const direct = await open(databaseUrl!)
    await direct.query(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id TEXT PRIMARY KEY)`)
    await direct.query(`INSERT INTO ${PROBE_TABLE} (id) VALUES ('c1') ON CONFLICT DO NOTHING`)
    cleanups.push(async () => {
      await direct.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
    })
    const proxy = await blackholeProxy(new URL(databaseUrl!), `FROM ${PROBE_TABLE}`)
    cleanups.push(proxy.close)
    const database = await open(proxy.url)

    const startedAt = performance.now()
    const failure = await database
      .transaction(
        async (transaction) =>
          await transaction.queryLocked(`SELECT id FROM ${PROBE_TABLE} WHERE id = ?`, ['c1'], {
            lockTimeoutMs: 200
          })
      )
      .catch((error: unknown) => error)
    const elapsedMs = performance.now() - startedAt

    expect(failure).toBeInstanceOf(Error)
    expect(isRelayDatabaseTransientError(failure)).toBe(true)
    expect(elapsedMs).toBeLessThan(READ_TIMEOUT_MS + 1_000)
    // pg's Terminate ('X') may follow as the client is destroyed; no statement may.
    const after = proxy.sentAfterTrigger()
    for (const statement of ['lock_timeout', 'ROLLBACK', 'COMMIT', 'SELECT']) {
      expect(after).not.toContain(statement)
    }
    // The next checkout is a fresh connection, so it is not stuck behind the lost reply.
    await expect(database.query('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }])
    // The row lock went with the destroyed session.
    await expect(
      direct.transaction(
        async (transaction) =>
          await transaction.queryLocked(`SELECT id FROM ${PROBE_TABLE} WHERE id = ?`, ['c1'], {
            failIfUnavailable: true
          })
      )
    ).resolves.toEqual([{ id: 'c1' }])
  }, 20_000)

  // The per-cell switch moves the margin per query, with no restart and no new pool.
  it('applies the switch file margin per query, over the pool margin', async () => {
    const direct = await open(databaseUrl!)
    await direct.query(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id TEXT PRIMARY KEY)`)
    cleanups.push(async () => {
      await direct.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
    })
    const proxy = await blackholeProxy(new URL(databaseUrl!), `FROM ${PROBE_TABLE}`)
    cleanups.push(proxy.close)
    let override: number | undefined = 1_000
    // The pool's own margin would hold the lost reply for 30 s.
    const database = await open(proxy.url, {
      readTimeoutMarginMs: 30_000,
      readTimeoutMarginOverrideMs: () => override
    })
    await expect(database.query('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }])
    const startedAt = performance.now()
    const failure = await database
      .query(`SELECT id FROM ${PROBE_TABLE}`)
      .catch((error: unknown) => error)
    expect(isRelayDatabaseTransientError(failure)).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(STATEMENT_TIMEOUT_MS + 1_000 + 1_000)
    override = undefined
    await expect(database.query('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }])
  }, 20_000)

  // A reply the server sent after statement_timeout, held up by a whole-VM stall, is still a
  // reply: the default margin must outlast the routine 5-7 s stalls.
  it('keeps a reply delayed 6.5 s by a stall, on the same connection', async () => {
    const proxy = await blackholeProxy(new URL(databaseUrl!), 'stalled_reply_probe', 6_500)
    cleanups.push(proxy.close)
    const database = await open(proxy.url, {
      readTimeoutMarginMs: POSTGRES_READ_TIMEOUT_MARGIN_MS,
      poolMax: 1
    })
    const pid = async () => (await database.query('SELECT pg_backend_pid() AS pid'))[0]?.pid
    const before = await pid()
    const startedAt = performance.now()
    // Autocommit: inside a transaction the proxy's hold would trip the server's own 5 s
    // idle-in-transaction limit, which a real VM stall pauses along with everything else.
    await expect(database.query("SELECT 'stalled_reply_probe' AS probe")).resolves.toEqual([
      { probe: 'stalled_reply_probe' }
    ])
    expect(performance.now() - startedAt).toBeGreaterThan(6_000)
    // Not destroyed: the one pooled connection is still the same backend.
    expect(await pid()).toBe(before)
  }, 30_000)

  it('runs request sessions with the server bounding idle backends at 30 s', async () => {
    const database = await open(databaseUrl!)
    await expect(
      database.query("SELECT current_setting('idle_session_timeout') AS value")
    ).resolves.toEqual([{ value: '30s' }])
  })
})
