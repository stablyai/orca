import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { openDelayedPostgresDatabase, type StatementDelay } from './test-fixtures/delayed-postgres-database.js'
import { RESERVE_MODE_CELL_ID, startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'

// E-mix on PostgreSQL: a reserve-mode cell flipped back to db leases every control it admitted
// from memory, disconnecting nobody, with the pool mostly left to DB-path work and one
// relay_cells write per tick, even with a cross-region round trip on every statement.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describePostgres('flipping a reserve-mode cell back on PostgreSQL', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
    // The database is shared with the other PostgreSQL suites, some of which read every cell.
    const database = await openRelayDatabase({ databaseUrl, dataDir: tmpdir() })
    try {
      const tables = await database.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name = 'cell_id' AND table_name LIKE 'relay_%'`
      )
      for (const row of tables) {
        await database.query(`DELETE FROM ${String(row.table_name)} WHERE cell_id = ?`, [RESERVE_MODE_CELL_ID])
      }
    } finally {
      await database.close()
    }
  })

  async function cellOn(database: RelayDatabase, databasePoolMax = 10) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-flip-back-pg-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    return await startReserveModeCell({ database, dataDir, cleanup, databasePoolMax })
  }

  it('re-registers every memory-admitted control, ten flips in a row', async () => {
    const database = await openRelayDatabase({ databaseUrl, dataDir: tmpdir() })
    cleanup.push(() => database.close())
    for (let flip = 0; flip < 10; flip += 1) {
      const cell = await cellOn(database)
      const hosts = []
      for (let index = 0; index < 3; index += 1) hosts.push(await cell.bookedHost(5 + index))
      const ids = new Set(hosts.map((entry) => entry.identity.hostId))
      const leased = async () =>
        (await cell.controlLeases()).filter((row) => ids.has(String(row.relay_host_id)))
      expect(await leased()).toEqual([])
      cell.setAdmitMode('db')
      await until(async () => (await leased()).length === 3, 10_000)
      await until(() => cell.relay.sessions.reregistrationPending() === 0, 10_000)
      expect(hosts.every((entry) => entry.socket.readyState === WebSocket.OPEN)).toBe(true)
      for (const entry of hosts) entry.socket.close()
    }
  }, 120_000)

  it('keeps re-registration to a third of the pool and one cell-row write per tick, at 170 ms a trip', async () => {
    const delay: StatementDelay = { enabled: false, delayMs: 170 }
    let cellRowWrites = 0
    let leaseWritesInFlight = 0
    let peakInFlight = 0
    delay.beforeTrip = async (sql) => {
      if (/UPDATE relay_cells\b/.test(sql)) cellRowWrites += 1
    }
    const database = openDelayedPostgresDatabase(databaseUrl!, delay, 10)
    cleanup.push(() => database.close())
    // The schema and the cell row, without the delay.
    const setup = await openRelayDatabase({ databaseUrl, dataDir: tmpdir() })
    await setup.close()
    const cell = await cellOn(database, 10)
    const deferred = cell.relay.assignments.activateControlDeferringCell.bind(cell.relay.assignments)
    vi.spyOn(cell.relay.assignments, 'activateControlDeferringCell').mockImplementation(async (...args) => {
      leaseWritesInFlight += 1
      peakInFlight = Math.max(peakInFlight, leaseWritesInFlight)
      try {
        return await deferred(...args)
      } finally {
        leaseWritesInFlight -= 1
      }
    })
    const hosts = []
    for (let index = 0; index < 9; index += 1) hosts.push(await cell.bookedHost(5 + index))
    const ids = new Set(hosts.map((entry) => entry.identity.hostId))
    delay.enabled = true
    const startedAt = Date.now()
    cell.setAdmitMode('db')
    await until(() => cell.relay.sessions.reregistrationPending() > 0, 5_000)
    await until(() => cell.relay.sessions.reregistrationPending() === 0, 45_000)
    const elapsedMs = Date.now() - startedAt
    delay.enabled = false
    const leased = (await cell.controlLeases()).filter((row) => ids.has(String(row.relay_host_id)))
    expect(leased).toHaveLength(9)
    expect(hosts.every((entry) => entry.socket.readyState === WebSocket.OPEN)).toBe(true)
    // Pool of 10: at most 3 activations at once, leaving 7 for hellos and renewals.
    expect(peakInFlight).toBeLessThanOrEqual(3)
    // Far fewer cell-row writes than activations: deltas fold into one write per tick.
    expect(cellRowWrites).toBeLessThan(9)
    process.stderr.write(`flip_back_latency ${JSON.stringify({ elapsedMs, peakInFlight, cellRowWrites })}\n`)
  }, 60_000)
})
