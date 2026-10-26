import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore, type AssignOptions, type RelayAssignment } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'
import { ReservePaceError } from './reserve-assignment.js'

const CELLS: RelayCellConfig[] = [
  { id: 'us-c1', url: 'https://us-c1.relay.example.com', region: 'us-central1', capacityRequests: 100 },
  { id: 'asia-c1', url: 'https://asia-c1.relay.example.com', region: 'asia-east2', capacityRequests: 100 }
]
const IDENTITY = { userId: 'spill-user', relayHostId: 'spillhost0000001' }
const ON_US_RESERVE: RelayAssignment = {
  ...IDENTITY,
  cellId: 'us-reserve',
  cellUrl: 'https://us-reserve.relay.example.com',
  assignmentEpoch: 8,
  leaseExpiresAt: 1_000_000,
  region: 'us-central1'
}

// Reports the target cell full when its reservation is taken: the race between pick and reserve.
class FullAtReserveDatabase implements RelayDatabase {
  armed = false

  constructor(private readonly delegate: RelayDatabase) {}

  get dialect(): 'sqlite' | 'postgres' | undefined {
    return this.delegate.dialect
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(sql: string, params?: unknown[], options?: RelayLockOptions): Promise<SqlRow[]> {
    const rows = await this.delegate.queryLocked(sql, params, options)
    if (!this.armed || sql.trim() !== 'SELECT * FROM relay_cells WHERE cell_id = ?') {
      return rows
    }
    return rows.map((row) => ({ ...row, reserved_requests: row.capacity_requests }))
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>, options?: RelayTransactionOptions): Promise<T> {
    return await this.delegate.transaction(async (inner) => {
      const wrapped = new FullAtReserveDatabase(inner)
      wrapped.armed = this.armed
      return await operation(wrapped)
    }, options)
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

describe('reserve spill before relay_capacity_exhausted', () => {
  let database: FullAtReserveDatabase
  let store: RelayAssignmentStore
  let now: number

  beforeEach(async () => {
    now = 100
    database = new FullAtReserveDatabase(await openInMemoryRelayDatabase())
    store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells(CELLS)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await database.close()
  })

  const closeAllDatabaseCells = async () => {
    for (const cell of CELLS) {
      await store.configureCell(cell, 'migration-only')
    }
  }
  const assignAsia = async (step5: AssignOptions) =>
    await store.assign(IDENTITY, 'asia-east2', 'asia-east2', undefined, step5)

  it('books a reserve seat when no database cell has room anywhere', async () => {
    await closeAllDatabaseCells()
    const reserveSpill = vi.fn(async () => ON_US_RESERVE)
    await expect(assignAsia({ reserveSpill })).resolves.toEqual({ ...ON_US_RESERVE, placed: true })
    expect(reserveSpill).toHaveBeenCalledWith({ skipOwnRegion: false, rowEpoch: 0 })
    expect(await database.query(`SELECT cell_id FROM relay_assignments`)).toEqual([])
  })

  it('skips the own region after the in-region reserve fallback already tried it', async () => {
    await closeAllDatabaseCells()
    const regionReserve = vi.fn(async () => null)
    const reserveSpill = vi.fn(async () => ON_US_RESERVE)
    await expect(assignAsia({ regionReserve, reserveSpill })).resolves.toMatchObject({ cellId: 'us-reserve' })
    expect(regionReserve).toHaveBeenCalledOnce()
    expect(reserveSpill).toHaveBeenCalledWith({ skipOwnRegion: true, rowEpoch: 0 })
  })

  it('hands the spill the epoch of the host row it read', async () => {
    const first = await assignAsia({})
    // Dormant: its next assign is a placement, which reads the row and finds no cell.
    await store.changeActivity(IDENTITY, 'control', -1)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.releaseExpiredActivity()
    now += ASSIGNMENT_LIMITS.dormantTtlMs
    await closeAllDatabaseCells()
    const reserveSpill = vi.fn(async () => ON_US_RESERVE)
    await assignAsia({ reserveSpill })
    expect(reserveSpill).toHaveBeenCalledWith({ skipOwnRegion: false, rowEpoch: first.assignmentEpoch })
  })

  it('refuses with relay_capacity_exhausted when no reserve seat exists either', async () => {
    await closeAllDatabaseCells()
    await expect(assignAsia({ reserveSpill: async () => null })).rejects.toThrow('relay_capacity_exhausted')
  })

  it('answers a paced spill with its pace, not a refusal', async () => {
    await closeAllDatabaseCells()
    const reserveSpill = vi.fn(async () => {
      throw new ReservePaceError(4)
    })
    await expect(assignAsia({ reserveSpill })).rejects.toBeInstanceOf(ReservePaceError)
  })

  it('answers an in-region reserve pace before any spill', async () => {
    await closeAllDatabaseCells()
    const reserveSpill = vi.fn(async () => ON_US_RESERVE)
    const regionReserve = async () => {
      throw new ReservePaceError(2)
    }
    await expect(assignAsia({ regionReserve, reserveSpill })).rejects.toBeInstanceOf(ReservePaceError)
    expect(reserveSpill).not.toHaveBeenCalled()
  })

  it('does not spill a reservation race: the host retries and re-picks', async () => {
    database.armed = true
    const reserveSpill = vi.fn(async () => ON_US_RESERVE)
    await expect(assignAsia({ reserveSpill })).rejects.toThrow('relay_capacity_exhausted')
    expect(reserveSpill).not.toHaveBeenCalled()
  })
})
