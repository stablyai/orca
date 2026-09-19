import { describe, expect, it } from 'vitest'
import {
  formatAssignmentInventorySnapshot,
  readAssignmentInventorySnapshot
} from './assignment-inventory-snapshot.js'
import { openInMemoryRelayDatabase } from './database.js'

describe('assignment inventory snapshot', () => {
  it('reports per-cell counters, lease backlog, and reservation debt', async () => {
    const database = await openInMemoryRelayDatabase()
    const now = 1_000_000
    await database.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES ('cell-a', 'https://a.example.test', 1, 4000, 3999, 5, ?, ?)`,
      [now, now]
    )
    await database.query(
      `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
       VALUES ('cell-a', 'general', ?)`,
      [now]
    )
    await database.query(
      `INSERT INTO relay_cell_runtime
       (cell_id, cell_url, cell_incarnation, started_at, ready, observed_requests,
        last_heartbeat_at, updated_at)
       VALUES ('cell-a', 'https://a.example.test', 'inc-1', ?, 1, 5, ?, ?)`,
      [now - 60_000, now - 10_000, now]
    )
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units,
        expires_at, updated_at)
       VALUES
       ('user-1', 'host-1', 'control:1', 'control', 'cell-a', 1, ?, ?),
       ('user-1', 'host-2', 'control:1', 'control', 'cell-a', 3, ?, ?)`,
      [now - 1, now, now + 90_000, now]
    )
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
        cell_id, state, created_at, timeout_at, updated_at)
       VALUES
       ('r1', 'k1', 'user-1', 'host-1', 1, 'cell-a', 'late-arrival-debt', ?, ?, ?),
       ('r2', 'k2', 'user-1', 'host-2', 1, 'cell-a', 'reserved', ?, ?, ?),
       ('r3', 'k3', 'user-1', 'host-3', 1, 'cell-a', 'claimed', ?, ?, ?),
       ('r4', 'k4', 'user-1', 'host-4', 1, 'cell-a', 'released', ?, ?, ?)`,
      [now, now, now, now, now, now, now, now, now, now, now, now]
    )

    const snapshot = await readAssignmentInventorySnapshot(database, now)

    expect(snapshot.cells).toEqual([
      {
        cellId: 'cell-a',
        region: 'us-central1',
        admissionState: 'general',
        enabled: true,
        capacityRequests: 4000,
        reservedRequests: 3999,
        runtimeReady: true,
        heartbeatAgeMs: 10_000
      }
    ])
    expect(snapshot.activityLeases).toEqual({ total: 2, expired: 1, requestUnits: 4 })
    expect(snapshot.connectionReservations).toEqual({ outstanding: 3, lateArrivalDebt: 1 })
    expect(snapshot.regionalRehomes).toEqual({
      active: 0,
      awaitingReceipt: 0,
      targetRegistered: 0,
      completedLast24Hours: 0,
      abortedLast24Hours: 0,
      oldestActiveAgeMs: null
    })

    const lines = formatAssignmentInventorySnapshot(snapshot)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('cellId=cell-a')
    expect(lines[0]).toContain('reserved=3999')
    expect(lines[1]).toContain('expiredLeases=1')
    expect(lines[1]).toContain('lateArrivalDebt=1')
    expect(lines[2]).toContain('active=0')
  })

  it('reports cells missing runtime and admission rows without failing', async () => {
    const database = await openInMemoryRelayDatabase()
    await database.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES ('cell-b', 'https://b.example.test', 0, 4000, 0, 0, 0, 0)`
    )

    const snapshot = await readAssignmentInventorySnapshot(database, 5_000)

    expect(snapshot.cells[0]).toMatchObject({
      cellId: 'cell-b',
      admissionState: 'unset',
      enabled: false,
      runtimeReady: null,
      heartbeatAgeMs: null
    })
    expect(snapshot.activityLeases).toEqual({ total: 0, expired: 0, requestUnits: 0 })
    expect(snapshot.regionalRehomes.active).toBe(0)
  })
})
