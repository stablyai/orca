import { beforeEach, describe, expect, it } from 'vitest'
import type { RelayCellConfig } from './config.js'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'

const CELL: RelayCellConfig = {
  id: 'accept-cell-a',
  url: 'https://accept-a.example.com',
  capacityRequests: 2
}
const host = { userId: 'accept-user', relayHostId: 'acceptho00000001' }
const second = { userId: 'accept-user', relayHostId: 'acceptho00000002' }
const third = { userId: 'accept-user', relayHostId: 'acceptho00000003' }

type Statement = { sql: string; locked: boolean }

// Records the statements a transaction issues, in order, so what the accept
// path does with the shared cell row can be asserted rather than described.
class RecordingDatabase implements RelayDatabase {
  constructor(
    private readonly inner: RelayDatabase,
    readonly statements: Statement[] = []
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    this.statements.push({ sql, locked: false })
    return await this.inner.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    this.statements.push({ sql, locked: true })
    return await this.inner.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options: RelayTransactionOptions = {}
  ): Promise<T> {
    return await this.inner.transaction(
      async (transaction) =>
        await operation(new RecordingDatabase(transaction, this.statements)),
      options
    )
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

describe('control accept cell-row lock span', () => {
  let recorder: RecordingDatabase
  let store: RelayAssignmentStore
  let assignmentEpoch: number

  beforeEach(async () => {
    recorder = new RecordingDatabase(await openInMemoryRelayDatabase())
    store = new RelayAssignmentStore(recorder, () => 100)
    await store.reconcileCells([CELL])
    assignmentEpoch = (await store.assign(host)).assignmentEpoch
  })

  async function accept(generation: number): Promise<string> {
    recorder.statements.length = 0
    return await store.activateControl(host, {
      cellId: CELL.id,
      assignmentEpoch,
      generation
    })
  }

  function cellStatements(): Statement[] {
    return recorder.statements.filter((statement) => /relay_cells/.test(statement.sql))
  }

  async function reservedRequests(): Promise<number> {
    const row = (
      await recorder.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [
        CELL.id
      ])
    )[0]!
    return Number(row.reserved_requests)
  }

  async function cellLeaseUnits(): Promise<number> {
    const row = (
      await recorder.query(
        `SELECT COALESCE(SUM(request_units), 0) AS units
         FROM relay_assignment_activity_leases WHERE cell_id = ?`,
        [CELL.id]
      )
    )[0]!
    return Number(row.units)
  }

  it('writes the shared cell row once, last, and never takes it as a read lock', async () => {
    const control = await accept(1)
    await store.releaseActivity(host, control)

    await accept(2)

    const cells = cellStatements()
    expect(cells.map((statement) => statement.locked)).toEqual([false])
    expect(cells[0]!.sql).toContain('RETURNING cell_id')
    // The contended row is written by the last statement of the transaction, so
    // its write lock is held across the commit alone, not the whole accept.
    expect(recorder.statements.at(-1)).toBe(cells[0])
  })

  it('leaves the cell row untouched when a rebind retires and installs one control', async () => {
    await accept(1)

    await accept(2)

    expect(cellStatements()).toEqual([])
    expect(await reservedRequests()).toBe(1)
    expect(await cellLeaseUnits()).toBe(1)
  })

  it('keeps the reservation equal to the cell lease units across repeated rebinds', async () => {
    for (const generation of [1, 2, 3, 4, 5]) await accept(generation)

    expect(await reservedRequests()).toBe(await cellLeaseUnits())
    expect(await reservedRequests()).toBe(1)
  })

  it('still refuses an accept that would exceed the cell capacity', async () => {
    const control = await accept(1)
    await store.assign(second)
    await store.releaseActivity(host, control)
    await store.assign(third)
    expect(await reservedRequests()).toBe(CELL.capacityRequests)

    await expect(accept(2)).rejects.toThrow('relay_capacity_exhausted')
    expect(await reservedRequests()).toBe(CELL.capacityRequests)
    expect(await cellLeaseUnits()).toBe(CELL.capacityRequests)
  })
})
