import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from '../../assignment/assignment-store.js'
import type { RelayCellConfig } from '../../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../../database/database.js'

const HEARTBEAT_TTL_MS = 45_000
const BOUND = 60
const OLD_INCARNATION = '11111111-1111-4111-8111-111111111111'

function cell(index: number, connectionHardCap: 1_000 | 3_000): RelayCellConfig {
  const id = `us-c${String(index).padStart(2, '0')}`
  return {
    id,
    url: `https://${id}.example.com`,
    region: 'us-central1',
    capacityRequests: 10_000,
    connectionHardCap,
    connectionUnobservedBound: BOUND
  }
}

const databases: RelayDatabase[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.close()
})

type Report = {
  connectionHardCap: number
  units?: number
  incarnation?: string
  startedAt?: number
  connectionUnobservedBound?: number
}

async function setup(cells: RelayCellConfig[]) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const now = 100
  const store = new RelayAssignmentStore(database, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(cells, true)
  const heartbeat = async (target: RelayCellConfig, report: Report): Promise<void> => {
    const units = report.units ?? 0
    await store.recordCellHeartbeat({
      cellId: target.id,
      cellUrl: target.url,
      cellIncarnation: report.incarnation ?? OLD_INCARNATION,
      startedAt: report.startedAt ?? 50,
      ready: true,
      observedRequests: 0,
      region: 'us-central1',
      totalConnections: units,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: units,
      connectionHardCap: report.connectionHardCap,
      connectionUnobservedBound: report.connectionUnobservedBound ?? BOUND
    })
  }
  const capacity = async (cellId: string) =>
    (await store.cellDeploymentStatus(cellId)).connectionCapacity
  const reportedHardCap = async (cellId: string): Promise<unknown> =>
    (
      await database.query(
        `SELECT reported_hard_cap FROM relay_cell_connection_limits WHERE cell_id = ?`,
        [cellId]
      )
    )[0]?.reported_hard_cap
  const telemetryRows = async (cellId: string): Promise<number> => {
    let rows = 0
    for (const table of ['relay_cell_connection_snapshots', 'relay_cell_connection_runtime']) {
      rows += (await database.query(`SELECT cell_id FROM ${table} WHERE cell_id = ?`, [cellId]))
        .length
    }
    return rows
  }
  return {
    database,
    store,
    heartbeat,
    capacity,
    reportedHardCap,
    telemetryRows
  }
}

describe('effective connection cap = min(configured, reported)', () => {
  it('accepts a report below the configured cap and places against the lower one', async () => {
    const configured = cell(1, 3_000)
    const harness = await setup([configured])
    // 1,000 - 100 rebind reserve - 60 unobserved = 840 pause; 839 used leaves one seat.
    await harness.heartbeat(configured, { connectionHardCap: 1_000, units: 839 })

    expect(await harness.capacity(configured.id)).toMatchObject({
      hardCap: 3_000,
      reportedHardCap: 1_000,
      effectiveHardCap: 1_000,
      ordinaryConnectionLimit: 900,
      normalAdmissionPause: 840,
      heartbeatFresh: true
    })
    await expect(
      harness.store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    ).resolves.toMatchObject({ cellId: configured.id })
    await expect(
      harness.store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })
    ).rejects.toThrow('relay_capacity_exhausted')
  })

  it('still refuses a report above the configured cap or with a different bound', async () => {
    const configured = cell(1, 1_000)
    const harness = await setup([configured])

    await expect(harness.heartbeat(configured, { connectionHardCap: 3_000 })).rejects.toThrow(
      'cell_connection_telemetry_mismatch'
    )
    await expect(
      harness.heartbeat(configured, { connectionHardCap: 1_000, connectionUnobservedBound: 59 })
    ).rejects.toThrow('cell_connection_telemetry_mismatch')
    expect(await harness.reportedHardCap(configured.id)).toBeNull()
  })

  it.each(['reconcile', 'admin'] as const)(
    'keeps the previous cap and the telemetry rows across a %s raise',
    async (path) => {
      const before = cell(1, 1_000)
      const harness = await setup([before])
      await harness.heartbeat(before, { connectionHardCap: 1_000, units: 839 })
      // A row a pre-change director wrote: it never stamped a report.
      await harness.database.query(
        `UPDATE relay_cell_connection_limits SET reported_hard_cap = NULL WHERE cell_id = ?`,
        [before.id]
      )
      const raised = cell(1, 3_000)
      if (path === 'reconcile') await harness.store.reconcileCells([raised], true)
      else await harness.store.configureCell(raised, 'general')

      expect(await harness.reportedHardCap(before.id)).toBe(1_000)
      expect(await harness.telemetryRows(before.id)).toBe(2)
      expect(await harness.capacity(before.id)).toMatchObject({
        hardCap: 3_000,
        effectiveHardCap: 1_000,
        normalAdmissionPause: 840,
        heartbeatFresh: true
      })
      // No heartbeat yet: one seat under the old cap, and not one more.
      await expect(
        harness.store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
      ).resolves.toMatchObject({ cellId: before.id })
      await expect(
        harness.store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })
      ).rejects.toThrow('relay_capacity_exhausted')
    }
  )

  it('keeps telemetry on a lowering, places against it and refuses the higher report', async () => {
    const before = cell(1, 3_000)
    const harness = await setup([before])
    await harness.heartbeat(before, { connectionHardCap: 3_000, units: 839 })
    await harness.store.reconcileCells([cell(1, 1_000)], true)

    expect(await harness.telemetryRows(before.id)).toBe(2)
    expect(await harness.capacity(before.id)).toMatchObject({
      hardCap: 1_000,
      effectiveHardCap: 1_000,
      normalAdmissionPause: 840,
      heartbeatFresh: true
    })
    await expect(
      harness.store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    ).resolves.toMatchObject({ cellId: before.id })
    await expect(
      harness.store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })
    ).rejects.toThrow('relay_capacity_exhausted')
    await expect(harness.heartbeat(before, { connectionHardCap: 3_000 })).rejects.toThrow(
      'cell_connection_telemetry_mismatch'
    )
  })

  it('still resets telemetry and fails placement closed on a bound change', async () => {
    const before = cell(1, 3_000)
    const harness = await setup([before])
    await harness.heartbeat(before, { connectionHardCap: 3_000, units: 10 })
    await harness.store.reconcileCells([{ ...before, connectionUnobservedBound: 50 }], true)

    expect(await harness.telemetryRows(before.id)).toBe(0)
    expect(await harness.capacity(before.id)).toMatchObject({ heartbeatFresh: false })
    await expect(
      harness.store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    ).rejects.toThrow('relay_capacity_exhausted')
  })
})
