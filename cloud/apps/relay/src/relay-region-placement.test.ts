import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const CELLS: RelayCellConfig[] = [
  {
    id: 'us-c1',
    url: 'https://us-c1.relay.example.com',
    region: 'us-central1',
    capacityRequests: 100
  },
  {
    id: 'asia-c1',
    url: 'https://asia-c1.relay.example.com',
    region: 'asia-east2',
    capacityRequests: 100
  },
  {
    id: 'asia-c2',
    url: 'https://asia-c2.relay.example.com',
    region: 'asia-east2',
    capacityRequests: 100
  },
  {
    id: 'asia-c3',
    url: 'https://asia-c3.relay.example.com',
    region: 'asia-east2',
    capacityRequests: 100
  }
]

describe('Relay regional placement', () => {
  let database: RelayDatabase
  let now: number
  let store: RelayAssignmentStore

  beforeEach(async () => {
    database = await openInMemoryRelayDatabase()
    now = 1_000
    store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells(CELLS)
  })

  afterEach(async () => await database.close())

  it('prefers the requested region and keeps unhinted placement US-first', async () => {
    await expect(
      store.assign({ userId: 'asia-user', relayHostId: 'asiahost00000001' }, 'asia-east2')
    ).resolves.toMatchObject({ cellId: 'asia-c1', region: 'asia-east2' })
    await expect(
      store.assign({ userId: 'us-user', relayHostId: 'ushost0000000001' })
    ).resolves.toMatchObject({ cellId: 'us-c1', region: 'us-central1' })
  })

  it('falls back globally only when the target region has no safe general cell', async () => {
    await store.configureCell(CELLS[1]!, 'migration-only')
    await store.configureCell(CELLS[2]!, 'migration-only')
    await store.configureCell(CELLS[3]!, 'migration-only')

    await expect(
      store.assign({ userId: 'fallback-user', relayHostId: 'fallbackhost0001' }, 'asia-east2')
    ).resolves.toMatchObject({ cellId: 'us-c1', region: 'us-central1' })
  })

  it('preserves sticky assignments while updating only explicit preferences', async () => {
    const identity = { userId: 'sticky-user', relayHostId: 'stickyhost000001' }
    await expect(store.assign(identity)).resolves.toMatchObject({ cellId: 'us-c1' })
    now = 2_000
    await expect(store.assign(identity, 'asia-east2')).resolves.toMatchObject({ cellId: 'us-c1' })
    now = 3_000
    await store.assign(identity)

    expect(
      await database.query(
        `SELECT preferred_region, observed_at FROM relay_assignment_region_preferences
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ preferred_region: 'asia-east2', observed_at: 2_000 }])
  })

  it('uses the explicit placement region as the server-side kill switch', async () => {
    await expect(
      store.assign(
        { userId: 'kill-user', relayHostId: 'killhost00000001' },
        'asia-east2',
        'us-central1'
      )
    ).resolves.toMatchObject({ cellId: 'us-c1', region: 'us-central1' })
    expect(await database.query(`SELECT preferred_region FROM relay_assignment_region_preferences`))
      .toEqual([{ preferred_region: 'asia-east2' }])
  })

  it('returns at most two deterministic healthy general probe origins per region', async () => {
    for (const [index, cell] of CELLS.entries()) {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        region: cell.region,
        cellIncarnation: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        startedAt: 1,
        ready: true,
        observedRequests: 0
      })
    }
    await store.configureCell(CELLS[2]!, 'migration-only')

    await expect(store.regionCatalog()).resolves.toEqual([
      { region: 'us-central1', probeOrigins: ['https://us-c1.relay.example.com'] },
      {
        region: 'asia-east2',
        probeOrigins: [
          'https://asia-c1.relay.example.com',
          'https://asia-c3.relay.example.com'
        ]
      }
    ])

    await database.query(`UPDATE relay_cells SET enabled = 0 WHERE cell_id = ?`, ['asia-c3'])
    await expect(store.regionCatalog()).resolves.toEqual([
      { region: 'us-central1', probeOrigins: ['https://us-c1.relay.example.com'] },
      { region: 'asia-east2', probeOrigins: ['https://asia-c1.relay.example.com'] }
    ])
  })

  it('rejects a heartbeat whose explicit region conflicts with registration', async () => {
    await expect(
      store.recordCellHeartbeat({
        cellId: 'asia-c1',
        cellUrl: 'https://asia-c1.relay.example.com',
        region: 'us-central1',
        cellIncarnation: '00000000-0000-4000-8000-000000000001',
        startedAt: 1,
        ready: true,
        observedRequests: 0
      })
    ).rejects.toThrow('cell_region_mismatch')
  })

  it('defaults cells inserted by an old process after startup to US', async () => {
    const oldCell = {
      id: 'old-us-cell',
      url: 'https://old-us-cell.relay.example.com',
      capacityRequests: 100
    }
    await database.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES (?, ?, 1, 100, 0, 0, ?, ?)`,
      [oldCell.id, oldCell.url, now, now]
    )
    await database.query(
      `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
       VALUES (?, 'general', ?)`,
      [oldCell.id, now]
    )
    await Promise.all(CELLS.map((cell) => store.configureCell(cell, 'migration-only')))

    const identity = { userId: 'old-user', relayHostId: 'oldhost000000001' }
    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: oldCell.id,
      region: 'us-central1'
    })
    await expect(store.resolve(identity)).resolves.toMatchObject({
      cellId: oldCell.id,
      region: 'us-central1'
    })
    await expect(
      store.recordCellHeartbeat({
        cellId: oldCell.id,
        cellUrl: oldCell.url,
        cellIncarnation: '00000000-0000-4000-8000-000000000099',
        startedAt: 1,
        ready: true,
        observedRequests: 0
      })
    ).resolves.toBeUndefined()
  })

  it('expires identity-linked region preferences after 30 days', async () => {
    const identity = { userId: 'expiry-user', relayHostId: 'expiryhost000001' }
    await store.assign(identity, 'asia-east2')
    now += 30 * 24 * 60 * 60_000 + 1

    await expect(store.releaseExpiredRegionPreferences()).resolves.toBe(1)
    await expect(
      database.query(
        `SELECT preferred_region FROM relay_assignment_region_preferences
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toEqual([])
  })
})
