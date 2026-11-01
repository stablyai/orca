import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { runClientTransaction, type CloudDatabase } from './cloud-database.js'

const LEADER_CONNECTION_TIMEOUT_MS = 2_000
const LEADER_STATEMENT_TIMEOUT_MS = 5_000
// Client-side: a check whose reply never comes (a half-open connection) still ends in time.
const LEADER_QUERY_TIMEOUT_MS = 10_000
const LEADER_POLL_MS = 5_000
// Also keeps the session from idling out; a check that fails ends leadership.
const LEADER_CHECK_MS = 15_000

export type Leadership = {
  // Settles when the lock may be gone: its connection failed or a check didn't come back.
  lost: Promise<void>
  // On the lock's own connection, so a leader that lost its lock can't commit anything.
  transaction: CloudDatabase['transaction']
  release(): Promise<void>
}

// Waits until this process holds the session advisory lock for key, so only one instance runs
// singleton work, such as a gateway connection, across a revision rollover. The lock lives as long
// as one dedicated connection; without a database URL (SQLite, one process) it is held at once
// and its transactions are the given database's.
export async function acquireLeadership(input: {
  databaseUrl?: string
  database: CloudDatabase
  key: string
  applicationName?: string
  signal: AbortSignal
  pollMs?: number
  checkMs?: number
}): Promise<Leadership> {
  if (!input.databaseUrl) {
    const { promise, resolve } = Promise.withResolvers<void>()
    return {
      lost: promise,
      transaction: (operation) => input.database.transaction(operation),
      release: async () => resolve()
    }
  }
  for (;;) {
    input.signal.throwIfAborted()
    const client = new pg.Client({
      connectionString: input.databaseUrl,
      application_name: input.applicationName ? `${input.applicationName}/leader` : undefined,
      connectionTimeoutMillis: LEADER_CONNECTION_TIMEOUT_MS,
      statement_timeout: LEADER_STATEMENT_TIMEOUT_MS,
      query_timeout: LEADER_QUERY_TIMEOUT_MS,
      keepAlive: true
    })
    // A dropped connection surfaces through the next query; this keeps it from crashing the process.
    client.on('error', () => undefined)
    try {
      await client.connect()
      for (;;) {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1::text)) AS locked',
          [input.key]
        )
        if (rows[0]?.locked === true) {
          return holdLeadership(client, input.checkMs ?? LEADER_CHECK_MS)
        }
        await sleep(input.pollMs ?? LEADER_POLL_MS, undefined, { signal: input.signal })
      }
    } catch (error) {
      await client.end().catch(() => undefined)
      if (input.signal.aborted) {
        throw error
      }
      console.warn(JSON.stringify({ event: 'orca_leader_lock_connection_failed', key: input.key }))
      await sleep(input.pollMs ?? LEADER_POLL_MS, undefined, { signal: input.signal })
    }
  }
}

function holdLeadership(client: pg.Client, checkMs: number): Leadership {
  const { promise: lost, resolve: markLost } = Promise.withResolvers<void>()
  let released = false
  let timer: NodeJS.Timeout | undefined
  const end = (): void => {
    clearTimeout(timer)
    markLost()
    void client.end().catch(() => undefined)
  }
  // One check at a time: the next is scheduled only after the last came back.
  const check = (): void => {
    timer = setTimeout(() => {
      client.query('SELECT 1').then(check, () => {
        if (!released) {
          console.warn(JSON.stringify({ event: 'orca_leader_lock_lost' }))
        }
        end()
      })
    }, checkMs)
  }
  check()
  client.on('error', end)
  client.on('end', end)
  return {
    lost,
    transaction: (operation) => runClientTransaction(client, operation),
    release: async () => {
      released = true
      clearTimeout(timer)
      // Ending the session releases the lock.
      await client.end().catch(() => undefined)
      markLost()
    }
  }
}
