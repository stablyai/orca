import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'

import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from '../cell/admission/cell-admission-selector.js'
import type { RelayCellConfig } from '../config.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from '../database/database.js'

// migration-only also holds evacuation targets, Asia rollback and failed-wave/new cells; only same-cap isolate writes rollIsolatedCells, and restore clears its stamp atomically (orca-relay-operations.md).
const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-a', relayHostId: 'host000000000001' }

// A connection-limited cell is what makes deadCellFenceRequirement report capped,
// which is the branch that answers 503 relay_home_cell_unavailable.
const CAPPED = {
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
} as const
const CELLS: RelayCellConfig[] = [
  { id: 'us-c1', url: 'https://us-c1.example.com', region: 'us-central1', ...CAPPED },
  { id: 'us-c2', url: 'https://us-c2.example.com', region: 'us-central1', ...CAPPED },
  { id: 'asia-c1', url: 'https://asia-c1.example.com', region: 'asia-east2', ...CAPPED }
]

const databases: RelayDatabase[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.close()
})

class WriteFailureDatabase implements RelayDatabase {
  // Fails the first statement containing this fragment, so a test can roll a
  // transaction back at a chosen point.
  failOnce: string | undefined

  constructor(private readonly delegate: RelayDatabase) {}

  get dialect(): 'sqlite' | 'postgres' | undefined {
    return this.delegate.dialect
  }

  record(sql: string): void {
    if (this.failOnce !== undefined && sql.includes(this.failOnce)) {
      this.failOnce = undefined
      throw new Error('injected_placement_write_failure')
    }
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    this.record(sql)
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    this.record(sql)
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    return await this.delegate.transaction(
      async (inner) => await operation(this.recording(inner)),
      options
    )
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }

  // Inject the failure inside the transaction so the real database rolls it back.
  private recording(inner: RelayDatabase): RelayDatabase {
    return {
      dialect: inner.dialect,
      query: async (sql, params) => {
        this.record(sql)
        return await inner.query(sql, params)
      },
      queryLocked: async (sql, params, options) => {
        this.record(sql)
        return await inner.queryLocked(sql, params, options)
      },
      transaction: async (operation, options) => await inner.transaction(operation, options),
      close: async () => await inner.close()
    }
  }
}

interface Harness {
  store: RelayAssignmentStore
  database: RelayDatabase
  counter: WriteFailureDatabase
  heartbeat: (cell: RelayCellConfig, at?: number) => Promise<void>
  setNow: (value: number) => void
  /** The real isolate path: one selector apply that names the cell it stamps. */
  isolateForRoll: (cellId: string) => Promise<void>
  /** The real restore path: back to 'general', which clears the stamp. */
  restore: (cellId: string) => Promise<void>
  /** An admission move with no stamp — every flow that is not a same-cap roll. */
  park: (cellId: string, state: CellAdmissionState) => Promise<void>
  rollIsolatedAt: (cellId: string) => Promise<number | null>
}

async function setup(cells: RelayCellConfig[] = CELLS): Promise<Harness> {
  const inner = await openInMemoryRelayDatabase()
  databases.push(inner)
  const counter = new WriteFailureDatabase(inner)
  let now = START_MS
  const store = new RelayAssignmentStore(counter, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(cells, true)
  const heartbeat = async (cell: RelayCellConfig, at?: number): Promise<void> => {
    const previous = now
    if (at !== undefined) now = at
    try {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: `1111111${cells.indexOf(cell)}-1111-4111-8111-111111111111`,
        startedAt: 50,
        ready: true,
        observedRequests: 0,
        region: cell.region,
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0,
        connectionHardCap: cell.connectionHardCap ?? 600,
        connectionUnobservedBound: cell.connectionUnobservedBound ?? 50
      })
    } finally {
      if (at !== undefined) now = previous
    }
  }
  for (const cell of cells) await heartbeat(cell)

  const applySelector = async (
    states: Record<string, CellAdmissionState>,
    rollIsolatedCells?: string[]
  ): Promise<void> => {
    const current = await store.inspectCellAdmissionSelector()
    const membership: CellAdmissionMembership = {
      existingOnly: [],
      migrationOnly: [],
      general: []
    }
    for (const cell of cells) {
      const state =
        states[cell.id] ??
        (current.selector.membership.migrationOnly.includes(cell.id)
          ? 'migration-only'
          : current.selector.membership.existingOnly.includes(cell.id)
            ? 'existing-only'
            : 'general')
      if (state === 'migration-only') membership.migrationOnly.push(cell.id)
      else if (state === 'existing-only') membership.existingOnly.push(cell.id)
      else membership.general.push(cell.id)
    }
    await store.applyCellAdmissionSelector({
      attemptId: `attempt-${current.selector.generation}-${Object.keys(states).join('-')}`,
      expectedGeneration: current.selector.generation,
      ...(current.selector.generation === 0
        ? {
            expectedMembershipSha256: createHash('sha256')
              .update(encodeMembership(current.selector.membership))
              .digest('hex')
          }
        : {}),
      membership,
      ...(rollIsolatedCells ? { rollIsolatedCells } : {})
    })
  }

  return {
    store,
    database: inner,
    counter,
    heartbeat,
    setNow: (value: number) => (now = value),
    isolateForRoll: async (cellId) => await applySelector({ [cellId]: 'migration-only' }, [cellId]),
    restore: async (cellId) => await applySelector({ [cellId]: 'general' }),
    park: async (cellId, state) => await applySelector({ [cellId]: state }),
    rollIsolatedAt: async (cellId) => {
      const rows = await inner.query(
        `SELECT roll_isolated_at FROM relay_cell_admission WHERE cell_id = ?`,
        [cellId]
      )
      const value = rows[0]?.['roll_isolated_at']
      return value === undefined || value === null ? null : Number(value)
    }
  }
}

type ConsoleWarnSpy = { mock: { calls: unknown[][] } }

function jsonEvents(warn: ConsoleWarnSpy, event: string): unknown[] {
  return warn.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .filter((line) => line.includes(`"${event}"`))
    .map((line) => JSON.parse(line) as unknown)
}

describe('re-placing a host off a cell isolated for a roll', () => {
  it('emits nothing when the placement rolls back after the decision', async () => {
    // Log only committed moves; stdout cannot roll back with a failed lease/reservation transaction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, counter, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    warn.mockClear()
    // The first write after the event is decided.
    counter.failOnce = 'INSERT INTO relay_assignments'
    await expect(store.assign(IDENTITY, 'us-central1')).rejects.toThrow(
      'injected_placement_write_failure'
    )

    expect(jsonEvents(warn, 'orca_relay_sticky_replaced_off_isolated_cell')).toEqual([])
    // Prove the move rolled back so the missing event is required, not merely delayed.
    expect(await store.resolve(IDENTITY)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })

    // Successful control proves event absence above comes from rollback, not a broken harness.
    warn.mockClear()
    const moved = await store.assign(IDENTITY, 'us-central1')
    expect(moved.cellId).not.toBe(first.cellId)
    expect(jsonEvents(warn, 'orca_relay_sticky_replaced_off_isolated_cell')).toHaveLength(1)
  })
})
