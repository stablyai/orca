import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from '../../database/database.js'

const fakes = vi.hoisted(() => ({
  statements: [] as string[],
  query: vi.fn(async (sql: string) => {
    fakes.statements.push(sql)
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
  // A real pooled client is an EventEmitter, and the acquire path attaches an
  // `error` listener to it before handing it to the caller.
  client: () => ({
    query: fakes.query,
    release: fakes.release,
    on: vi.fn(),
    removeListener: vi.fn()
  }),
  end: vi.fn(async () => undefined)
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 1
      idleCount = 1
      waitingCount = 0
      end = fakes.end
      on = vi.fn()
      connect = vi.fn(async () => fakes.client())
    }
  }
}))

const { openRelayDatabase } = await import('../../database/database.js')

const CELL_INVENTORY_SQL = 'SELECT * FROM relay_cells ORDER BY cell_id ASC'

async function openFakePostgres(): Promise<RelayDatabase> {
  const database = await openRelayDatabase({
    databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
    dataDir: './unused'
  })
  fakes.statements.length = 0
  return database
}

afterEach(() => {
  fakes.statements.length = 0
  fakes.query.mockReset()
  fakes.query.mockImplementation(async (sql: string) => {
    fakes.statements.push(sql)
    return { rows: [], rowCount: 0 }
  })
})

// Why: exhausted transactions count against the incident monitor's bounded bar.
// A sweep that steps aside must not spend the retry budget or report a terminal failure.
describe('sweep lock skips stay off the transaction retry counters', () => {
  it('reports neither a retry nor an exhaustion when NOWAIT finds the lock held', async () => {
    const database = await openFakePostgres()
    fakes.query.mockImplementation(async (sql: string) => {
      fakes.statements.push(sql)
      if (sql.includes('FOR UPDATE NOWAIT')) {
        throw Object.assign(new Error('could not obtain lock'), { code: '55P03' })
      }
      return { rows: [], rowCount: 0 }
    })
    const events: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      try {
        events.push(String((JSON.parse(line as string) as { event?: unknown }).event))
      } catch {
        // non-JSON lines are not transaction telemetry
      }
    })

    try {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.queryLocked(CELL_INVENTORY_SQL, [], { failIfUnavailable: true })
        })
      ).rejects.toThrow('database_lock_unavailable')
    } finally {
      warn.mockRestore()
    }

    expect(events).not.toContain('orca_relay_postgres_transaction_retry')
    expect(events).not.toContain('orca_relay_postgres_transaction_exhausted')
    expect(fakes.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1)
    await database.close()
  })
})
