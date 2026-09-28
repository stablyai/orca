import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore, RelayHomeCellUnavailableError } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'

// `migration-only` alone says nothing about a roll: it is the admission class
// (cloud/docs/orca-relay-operations.md:229-233) that evacuation targets, Asia
// `--mode rollback`, a failed wave's re-isolate and newly registered cells all
// occupy durably while holding hosts. The same-cap roll's isolate step is the
// only writer of the roll stamp, via `rollIsolatedCells` on the selector apply
// (cloud/dev/scripts/prepare-relay-production-capacity-canary.mjs isolate mode);
// restore moves the cell to 'general', which clears the stamp in the same
// statement that writes the state.
const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-a', relayHostId: 'host000000000001' }

// A connection-limited cell is what makes deadCellRequiresCommittedFence true,
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

// Counts the reads this change adds, so the general hot path can be held to a
// single admission lookup and no migration lookup at all.
class QueryCountingDatabase implements RelayDatabase {
  readonly sql: string[] = []
  // Fails the first statement containing this fragment, so a test can roll a
  // transaction back at a chosen point.
  failOnce: string | undefined

  constructor(private readonly delegate: RelayDatabase) {}

  get dialect(): 'sqlite' | 'postgres' | undefined {
    return this.delegate.dialect
  }

  count(fragment: string): number {
    return this.sql.filter((statement) => statement.includes(fragment)).length
  }

  record(sql: string): void {
    this.sql.push(sql)
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

  // A nested transaction shares this one's tape, so a whole assign() is
  // measured as a unit.
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
  counter: QueryCountingDatabase
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
  const counter = new QueryCountingDatabase(inner)
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
    isolateForRoll: async (cellId) =>
      await applySelector({ [cellId]: 'migration-only' }, [cellId]),
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

async function insertMigration(
  database: RelayDatabase,
  input: {
    sourceCellId: string
    targetCellId: string
    assignmentEpoch: number
    leases: number
    settled?: 'completed' | 'aborted'
  }
): Promise<void> {
  await database.query(
    `INSERT INTO relay_assignment_migrations
     (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch,
      assignment_epoch, source_request_units, target_reserved_units, expires_at,
      target_registered_at, completed_at, aborted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, NULL, ?, ?, ?, ?)`,
    [
      IDENTITY.userId,
      IDENTITY.relayHostId,
      input.sourceCellId,
      input.targetCellId,
      input.assignmentEpoch - 1,
      input.assignmentEpoch,
      START_MS + 900_000,
      input.settled === 'completed' ? START_MS : null,
      input.settled === 'aborted' ? START_MS : null,
      START_MS,
      START_MS
    ]
  )
  await database.query(
    `UPDATE relay_assignments SET migration_leases = ?
     WHERE user_id = ? AND relay_host_id = ?`,
    [input.leases, IDENTITY.userId, IDENTITY.relayHostId]
  )
}

type ConsoleWarnSpy = { mock: { calls: unknown[][] } }

function jsonEvents(warn: ConsoleWarnSpy, event: string): unknown[] {
  return warn.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .filter((line) => line.includes(`"${event}"`))
    .map((line) => JSON.parse(line) as unknown)
}

describe('re-placing a host off a cell isolated for a roll', () => {
  it('leaves a host on a live general cell untouched, at one added admission read', async () => {
    const { store, counter } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')

    counter.sql.length = 0
    const second = await store.assign(IDENTITY, 'us-central1')

    // Identical, not merely same-celled: the clock has not moved, so every
    // field including the lease deadline must match.
    expect(second).toEqual(first)
    // One row read answers both the stranded rule and the roll-stamp check.
    expect(counter.count('relay_cell_admission')).toBe(1)
    expect(counter.count('relay_assignment_migrations')).toBe(0)
    // No placement: the sticky lane never reaches the fleet-wide inventory.
    expect(counter.count('ORDER BY cell_id ASC')).toBe(0)
  })

  it('keeps a host pinned to a migration-only cell with no roll stamp', async () => {
    // The guard for every non-roll flow that parks a loaded cell: an Asia
    // `--mode rollback`, an evacuation target awaiting promotion, a failed
    // wave's re-isolate. Moving these hosts would undo the operator's intent.
    const { store, park, rollIsolatedAt } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await park(first.cellId, 'migration-only')

    expect(await rollIsolatedAt(first.cellId)).toBeNull()
    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('re-places a host once the roll stamp is set', async () => {
    const { store, counter, isolateForRoll, rollIsolatedAt } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    expect(await rollIsolatedAt(first.cellId)).toBe(START_MS)
    counter.sql.length = 0
    const moved = await store.assign(IDENTITY, 'us-central1')

    expect(moved.cellId).not.toBe(first.cellId)
    expect(moved.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    expect(counter.count('relay_assignment_migrations')).toBeGreaterThan(0)

    // Durable: the next dial does not bounce back to the isolated cell.
    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: moved.cellId,
      assignmentEpoch: moved.assignmentEpoch
    })
  })

  it.each([
    { label: 'just inside the bound', age: 2 * 60 * 60_000 - 1, moves: true },
    { label: 'just outside the bound', age: 2 * 60 * 60_000 + 1, moves: false }
  ])('treats a stamp $label as $moves', async ({ age, moves }) => {
    // Why the bound exists: a roll isolates and restores inside ~15 minutes, so
    // an older stamp is a failed wave waiting on an operator, or an orphan left
    // by a director rollback whose restore predates the clearing clause. Both
    // mean a possibly healthy cell, and the safe answer is the pre-existing one.
    const { store, heartbeat, isolateForRoll, setNow } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    const later = START_MS + age
    setNow(later)
    for (const cell of CELLS) await heartbeat(cell, later)
    const grant = await store.assign(IDENTITY, 'us-central1')

    if (moves) {
      expect(grant.cellId).not.toBe(first.cellId)
      expect(grant.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    } else {
      expect(grant.cellId).toBe(first.cellId)
      expect(grant.assignmentEpoch).toBe(first.assignmentEpoch)
    }
  })

  it('stops re-placing once restore clears the stamp', async () => {
    const { store, isolateForRoll, restore, rollIsolatedAt } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)
    await restore(first.cellId)

    expect(await rollIsolatedAt(first.cellId)).toBeNull()
    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('keeps a host pinned to an existing-only cell that still serves it', async () => {
    // Why: existing-only cells serve the hosts they already hold (PR #194). Only
    // assignmentStrandedOnUnservedCell may release that pin, and only on proof
    // the cell stopped serving this host.
    const { store, database, heartbeat, park, setNow } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await park(first.cellId, 'existing-only')
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, 'control:live-1', 'control', ?, 1, ?, ?)`,
      [IDENTITY.userId, IDENTITY.relayHostId, first.cellId, START_MS + 600_000, START_MS]
    )

    // Past the stranded rule's minimum grant age, which outlives the heartbeat TTL.
    setNow(START_MS + 61_000)
    for (const cell of CELLS) await heartbeat(cell, START_MS + 61_000)
    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('keeps a host pinned on an unstamped cell whose migration has completed', async () => {
    // The terminal state of a successful evacuation: the host's row points at
    // the target, the migration is completed, and the cell waits migration-only
    // for a separate promote dispatch. Re-placing here undoes the evacuation.
    const { store, database, park } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await insertMigration(database, {
      sourceCellId: 'us-c2',
      targetCellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      leases: 0,
      settled: 'completed'
    })
    await park(first.cellId, 'migration-only')

    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('re-places a stamped cell whose migration has completed', async () => {
    const { store, database, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await insertMigration(database, {
      sourceCellId: 'us-c2',
      targetCellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      leases: 0,
      settled: 'completed'
    })
    await isolateForRoll(first.cellId)

    expect((await store.assign(IDENTITY, 'us-central1')).cellId).not.toBe(first.cellId)
  })

  it('keeps the pin while a migration lease is outstanding', async () => {
    const { store, database, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await insertMigration(database, {
      sourceCellId: first.cellId,
      targetCellId: 'us-c2',
      assignmentEpoch: first.assignmentEpoch,
      leases: 1
    })
    await isolateForRoll(first.cellId)

    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('keeps the pin while a migration row is open but its lease has lapsed', async () => {
    // Why: the durable relay_assignment_migrations row outlives the 15-minute
    // lease the counter tracks, and rollBackStalledRegionalRehomes refuses to
    // unwind it while the source is not general. Re-placing would strand it.
    const { store, database, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await insertMigration(database, {
      sourceCellId: first.cellId,
      targetCellId: 'us-c2',
      assignmentEpoch: first.assignmentEpoch,
      leases: 0
    })
    await isolateForRoll(first.cellId)

    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('never re-places across a region boundary, and says so', async () => {
    // Both US cells parked and only Asia general: ordinary placement would spill
    // to asia-east2 through `preferred[0] ?? candidates[0]`. This path refuses.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, isolateForRoll, park } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    const other = CELLS.find((cell) => cell.region === 'us-central1' && cell.id !== first.cellId)!
    await park(other.id, 'migration-only')
    await isolateForRoll(first.cellId)

    warn.mockClear()
    expect(await store.assign(IDENTITY, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
    expect(jsonEvents(warn, 'orca_relay_sticky_replacement_deferred')).toEqual([
      {
        event: 'orca_relay_sticky_replacement_deferred',
        reason: 'no_same_region_headroom',
        cellId: first.cellId,
        region: 'us-central1'
      }
    ])
    expect(jsonEvents(warn, 'orca_relay_sticky_replaced_off_isolated_cell')).toEqual([])
  })

  it('keeps a re-placed host in its own region', async () => {
    const { store, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'asia-east2')
    expect(first.region).toBe('asia-east2')
    await isolateForRoll(first.cellId)

    // asia-c1 is the only Asia cell, so the only in-region candidate is gone.
    expect(await store.assign(IDENTITY, 'asia-east2')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('takes the dead-cell path when a stamped cell stops heartbeating', async () => {
    // Why: the fence is the only proof that a cell we cannot reach has stopped
    // serving the sockets it still holds. A stamp does not make it reachable.
    const { store, heartbeat, isolateForRoll, setNow } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    const stale = START_MS + HEARTBEAT_TTL_MS + 1_000
    setNow(stale)
    for (const cell of CELLS) {
      if (cell.id !== first.cellId) await heartbeat(cell, stale)
    }

    await expect(store.assign(IDENTITY, 'us-central1')).rejects.toBeInstanceOf(
      RelayHomeCellUnavailableError
    )
  })

  it('does not demand a committed fence while the stamped cell is live', async () => {
    const { store, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    const moved = await store.assign(IDENTITY, 'us-central1').catch((error: unknown) => error)
    expect(moved).not.toBeInstanceOf(RelayHomeCellUnavailableError)
    expect(moved).toMatchObject({ assignmentEpoch: first.assignmentEpoch + 1 })
  })

  it('leaves the source cell activity leases in place', async () => {
    // Contrast with the fence and stranded paths, which delete them: an isolated
    // cell is alive and still owns drainable work behind those leases.
    const { store, database, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, 'splice:keep-1', 'splice', ?, 1, ?, ?)`,
      [IDENTITY.userId, IDENTITY.relayHostId, first.cellId, START_MS + 600_000, START_MS]
    )
    await isolateForRoll(first.cellId)

    await store.assign(IDENTITY, 'us-central1')
    expect(
      await database.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = 'splice:keep-1'`,
        [IDENTITY.userId, IDENTITY.relayHostId]
      )
    ).toHaveLength(1)
  })

  it('emits nothing when the placement rolls back after the decision', async () => {
    // Why: the decision and the writes share one transaction. A line already on
    // stdout cannot be rolled back with it, so an event written where it is
    // decided would have the canary counting moves that never happened.
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
    // The precondition for reading that absence: the move really was rolled
    // back, so the event would have been a lie rather than merely early.
    expect(await store.resolve(IDENTITY)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })

    // Control: the same dial with nothing injected does emit, so the assertion
    // above is measuring the rollback and not a broken harness.
    warn.mockClear()
    const moved = await store.assign(IDENTITY, 'us-central1')
    expect(moved.cellId).not.toBe(first.cellId)
    expect(jsonEvents(warn, 'orca_relay_sticky_replaced_off_isolated_cell')).toHaveLength(1)
  })

  it('logs one event naming both cells, the admission state and the region', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, isolateForRoll } = await setup()
    const first = await store.assign(IDENTITY, 'us-central1')
    await isolateForRoll(first.cellId)

    warn.mockClear()
    const moved = await store.assign(IDENTITY, 'us-central1')

    expect(jsonEvents(warn, 'orca_relay_sticky_replaced_off_isolated_cell')).toEqual([
      {
        event: 'orca_relay_sticky_replaced_off_isolated_cell',
        fromCellId: first.cellId,
        fromRegion: 'us-central1',
        admissionState: 'migration-only',
        toCellId: moved.cellId,
        region: moved.region
      }
    ])
  })
})
