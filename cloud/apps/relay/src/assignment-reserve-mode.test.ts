import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore, RelayCellInReserveModeError } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

describe('assignment reserve-mode behavior', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  async function setup(now: () => number, reserve: string[] = []) {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells(CELLS)
    await setReserve(store, reserve)
    return store
  }

  async function setReserve(store: RelayAssignmentStore, reserve: string[]) {
    for (const cell of CELLS) {
      await store.setCellAdmitMode(cell.id, reserve.includes(cell.id) ? 'reserve' : 'db')
    }
  }

  // A store that has never read the set: the table is unreadable.
  async function unknownSet(now: () => number) {
    const unknown = new RelayAssignmentStore(database!, now)
    await database!.query('ALTER TABLE relay_cell_admit_modes RENAME TO relay_cell_admit_modes_gone')
    return {
      unknown,
      restore: async () =>
        await database!.query('ALTER TABLE relay_cell_admit_modes_gone RENAME TO relay_cell_admit_modes')
    }
  }

  it('lets no expiry sweep touch a reserve-mode cell, and runs none while the set is unknown', async () => {
    let now = 1_000
    const store = await setup(() => now)
    const onA = { userId: 'user-a', relayHostId: 'host000000000001' }
    expect((await store.assign(onA)).cellId).toBe('cell-a')
    await store.acquireActivity(onA, { activityId: 'invite:one', kind: 'invite', cellId: 'cell-a' })
    await setReserve(store, ['cell-a'])
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.releaseExpiredActivityLeases()).toBe(0)
    expect(await store.releaseExpiredActivity()).toBe(0)
    const { unknown, restore } = await unknownSet(() => now)
    expect(await unknown.reserveModeCells()).toBeNull()
    expect(await unknown.releaseExpiredActivityLeases()).toBe(0)
    expect(await unknown.evacuateDeadCells()).toBe(0)
    await restore()
    await setReserve(store, [])
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
  })

  it('logs an unreadable reserve-mode set at most once a minute', async () => {
    let now = 1_000
    await setup(() => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clock = vi.spyOn(performance, 'now')
    let at = 1_000_000
    clock.mockImplementation(() => at)
    const { unknown, restore } = await unknownSet(() => now)
    try {
      for (let read = 0; read < 3; read += 1) {
        expect(await unknown.reserveModeCells()).toBeNull()
        at += 10_000
      }
      at += 60_000
      expect(await unknown.reserveModeCells()).toBeNull()
      const lines = warn.mock.calls.filter(([line]) => String(line).includes('orca_relay_reserve_mode_read_failed'))
      expect(lines).toHaveLength(2)
    } finally {
      await restore()
      clock.mockRestore()
      warn.mockRestore()
    }
  })

  it('tells break glass whether a cell is still heartbeating', async () => {
    let now = 1_000
    const store = await setup(() => now)
    expect(await store.cellHeartbeatFresh('cell-a')).toBe(false)
    await store.reconcileCells([{ ...CELLS[0]!, connectionHardCap: 600, connectionUnobservedBound: 50 }, CELLS[1]!])
    await store.recordCellHeartbeat({
      cellId: 'cell-a',
      cellUrl: CELLS[0]!.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: false,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    // Not ready is still alive: break glass is for a cell that has gone silent.
    expect(await store.cellHeartbeatFresh('cell-a')).toBe(true)
    now += 45_001
    expect(await store.cellHeartbeatFresh('cell-a')).toBe(false)
  })

  it('keeps an idle host sticky on a reserve-mode cell where today it would be re-placed', async () => {
    let now = 1_000
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'control', -1)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
    await setReserve(store, [first.cellId])
    expect(await store.assign(identity)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
    // Not knowing which cells are switched on is treated the same way.
    const { unknown, restore } = await unknownSet(() => now)
    expect((await unknown.assign(identity)).assignmentEpoch).toBe(first.assignmentEpoch)
    await restore()
  })

  it('keeps a connected host pinned when its reserve cell goes existing-only after a ledger write', async () => {
    let now = 1_000
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await setReserve(store, [first.cellId])
    // The reserve ledger stamps last_activity_at and the cell keeps no activity rows.
    now += 5 * 60_000
    await database!.query('DELETE FROM relay_assignment_activity_leases WHERE user_id = ?', [identity.userId])
    await database!.query('UPDATE relay_assignments SET last_activity_at = ? WHERE user_id = ?', [now, identity.userId])
    await store.setCellAdmissionState(first.cellId, 'existing-only')
    now += 2 * 60_000
    expect(await store.assign(identity)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
    const { unknown, restore } = await unknownSet(() => now)
    expect((await unknown.assign(identity)).assignmentEpoch).toBe(first.assignmentEpoch)
    await restore()
  })

  // Only the first reserve-set read is held; it is released (or failed) by the test.
  function holdFirstRead(options: { fail?: boolean } = {}) {
    const query = database!.query.bind(database!)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const counter = { reads: 0 }
    database!.query = async (sql, params) => {
      if (sql.includes('FROM relay_cell_admit_modes m')) {
        counter.reads += 1
        if (counter.reads === 1) {
          await released
          if (options.fail) throw new Error('canceling statement due to statement timeout')
        }
      }
      return await query(sql, params)
    }
    return { counter, release, restore: () => (database!.query = query) }
  }

  it('reads afresh after an admit-mode write instead of joining a read begun before it', async () => {
    const store = await setup(() => 1_000)
    const held = holdFirstRead()
    try {
      const before = store.reserveModeCells()
      await store.setCellAdmitMode('cell-a', 'reserve')
      const after = await Promise.race([
        store.reserveModeCells(),
        new Promise<'joined'>((resolve) => setTimeout(() => resolve('joined'), 500))
      ])
      expect(after === 'joined' ? after : [...(after ?? [])]).toEqual(['cell-a'])
      held.release()
      // The pre-write read lands after, and is not kept.
      await before
      expect([...((await store.reserveModeCells()) ?? [])]).toEqual(['cell-a'])
    } finally {
      held.release()
      held.restore()
    }
  })

  it('does not back off for a pre-write read that fails after the write', async () => {
    const store = await setup(() => 1_000)
    const held = holdFirstRead({ fail: true })
    try {
      const before = store.reserveModeCells()
      await store.setCellAdmitMode('cell-a', 'reserve')
      const reads = held.counter.reads
      held.release()
      await before
      // A write cleared the cache: the next caller reads now, not after a 5 s backoff.
      expect([...((await store.reserveModeCells()) ?? [])]).toEqual(['cell-a'])
      expect(held.counter.reads).toBeGreaterThan(reads)
    } finally {
      held.release()
      held.restore()
    }
  })

  // A table unreadable for over a minute leaves a stale set, not none: a host on a cell last
  // known to be in database mode is placed as today, not pinned as if its cell might be reserve.
  it('checks pins and dormancy against the last-known set once the read goes stale', async () => {
    let now = 1_000
    const clock = vi.spyOn(performance, 'now')
    let at = 5_000_000
    clock.mockImplementation(() => at)
    const store = await setup(() => now)
    try {
      const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
      const first = await store.assign(identity)
      await store.changeActivity(identity, 'control', -1)
      now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
      expect([...((await store.reserveModeCells()) ?? [])]).toEqual([])
      await database!.query('ALTER TABLE relay_cell_admit_modes RENAME TO relay_cell_admit_modes_gone')
      at += 61_000
      expect(await store.reserveModeCells()).toBeNull()
      expect((await store.assign(identity)).assignmentEpoch).toBeGreaterThan(first.assignmentEpoch)
    } finally {
      await database!.query('ALTER TABLE relay_cell_admit_modes_gone RENAME TO relay_cell_admit_modes').catch(() => undefined)
      clock.mockRestore()
    }
  })

  it('never places a fresh host on a reserve-mode cell through the database', async () => {
    const store = await setup(() => 1_000, ['cell-a'])
    for (let index = 0; index < 4; index += 1) {
      const placed = await store.assign({
        userId: `user-${index}`,
        relayHostId: `host${String(index).padStart(12, '0')}`
      })
      expect(placed.cellId).toBe('cell-b')
    }
  })

  it('refuses drains, evacuations and status reads that would treat a reserve-mode cell as empty', async () => {
    const store = await setup(() => 1_000, ['cell-a'])
    await expect(store.cellDeploymentStatus('cell-a')).rejects.toBeInstanceOf(
      RelayCellInReserveModeError
    )
    await expect(store.cellEvacuationCapacity('cell-a', 'cell-b')).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(store.startActiveCellEvacuations('cell-b', 'cell-a', 10)).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(
      store.prepareCellDrainAttempt({
        attemptId: '22222222-2222-4222-8222-222222222222',
        cellId: 'cell-a',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        traceValue: 'trace',
        plannedGraceMs: 1_000
      })
    ).rejects.toThrow('cell_in_reserve_mode')
    expect((await store.cellDeploymentStatus('cell-b')).cellId).toBe('cell-b')
    // Unknown refuses too, with a retryable error.
    const { unknown, restore } = await unknownSet(() => 1_000)
    await expect(unknown.cellDeploymentStatus('cell-b')).rejects.toThrow('reserve_mode_unknown')
    await restore()
  })

  it('refuses the flip to reserve while a migration names the cell', async () => {
    const store = await setup(() => 1_000)
    await database!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES ('user-a', 'host000000000001', 'cell-b', 'cell-a', 1, 2, 0, 1, 9999, 1000, 1000)`
    )
    await expect(store.setCellAdmitMode('cell-a', 'reserve')).rejects.toThrow('cell_has_open_migration')
    expect(await store.cellAdmitMode('cell-a')).toMatchObject({ admitMode: 'db' })
    await store.setCellAdmitMode('cell-a', 'db')
    await database!.query(`UPDATE relay_assignment_migrations SET aborted_at = 1001`)
    await store.setCellAdmitMode('cell-a', 'reserve')
    expect(await store.cellAdmitMode('cell-a')).toMatchObject({ admitMode: 'reserve', updatedAt: 1_000 })
  })
})
