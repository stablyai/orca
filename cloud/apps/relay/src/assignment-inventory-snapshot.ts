import type { RelayDatabase, SqlRow } from './database.js'

export type CellInventorySnapshotRow = {
  cellId: string
  region: string
  admissionState: string
  enabled: boolean
  capacityRequests: number
  reservedRequests: number
  runtimeReady: boolean | null
  heartbeatAgeMs: number | null
}

export type AssignmentInventorySnapshot = {
  cells: CellInventorySnapshotRow[]
  activityLeases: { total: number; expired: number; requestUnits: number }
  connectionReservations: { outstanding: number; lateArrivalDebt: number }
  regionalRehomes: {
    active: number
    awaitingReceipt: number
    targetRegistered: number
    completedLast24Hours: number
    abortedLast24Hours: number
    oldestActiveAgeMs: number | null
  }
}

// Plain SELECTs only: this snapshot must never take the cell-inventory lock,
// or observability itself would add to the assign-path lock contention.
export async function readAssignmentInventorySnapshot(
  database: RelayDatabase,
  now: number
): Promise<AssignmentInventorySnapshot> {
  const cellRows = await database.query(
    `SELECT cell.cell_id, cell.enabled, cell.capacity_requests, cell.reserved_requests,
            admission.admission_state, region.region,
            runtime.ready AS runtime_ready, runtime.last_heartbeat_at AS runtime_heartbeat_at
     FROM relay_cells cell
     LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
     LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
     LEFT JOIN relay_cell_runtime runtime ON runtime.cell_id = cell.cell_id
     ORDER BY cell.cell_id ASC`
  )
  const leaseRow = (
    await database.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired,
              COALESCE(SUM(request_units), 0) AS request_units
       FROM relay_assignment_activity_leases`,
      [now]
    )
  )[0]
  const reservationRow = (
    await database.query(
      // relay_cells is append-only in production; joining it lets the composite
      // index skip released history without hiding any production cell's debt.
      `SELECT COUNT(reservation.reservation_id) AS outstanding,
              COALESCE(SUM(CASE WHEN reservation.state = 'late-arrival-debt'
                                THEN 1 ELSE 0 END), 0) AS late_arrival_debt
       FROM relay_cells cell
       LEFT JOIN relay_control_connection_reservations reservation
         ON reservation.cell_id = cell.cell_id
        AND reservation.state IN ('reserved', 'late-arrival-debt', 'claimed')`
    )
  )[0]
  const regionalRehomeRow = (
    await database.query(
      `SELECT
         COALESCE(SUM(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
                           THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
                                AND attempt.drain_receipt_at IS NULL
                           THEN 1 ELSE 0 END), 0) AS awaiting_receipt,
         COALESCE(SUM(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
                                AND migration.target_registered_at IS NOT NULL
                           THEN 1 ELSE 0 END), 0) AS target_registered,
         COALESCE(SUM(CASE WHEN attempt.completed_at >= ? THEN 1 ELSE 0 END), 0)
           AS completed_last_24_hours,
         COALESCE(SUM(CASE WHEN attempt.aborted_at >= ? THEN 1 ELSE 0 END), 0)
           AS aborted_last_24_hours,
         MIN(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
                  THEN attempt.created_at END) AS oldest_active_at
       FROM relay_region_rehome_attempts attempt
       LEFT JOIN relay_assignment_migrations migration
         ON migration.user_id = attempt.user_id
        AND migration.relay_host_id = attempt.relay_host_id
        AND migration.assignment_epoch = attempt.assignment_epoch`,
      [now - 24 * 60 * 60_000, now - 24 * 60 * 60_000]
    )
  )[0]
  const oldestActiveAt = optionalInteger(regionalRehomeRow, 'oldest_active_at')
  return {
    cells: cellRows.map((row) => ({
      cellId: asText(row, 'cell_id'),
      region: optionalText(row, 'region') ?? 'us-central1',
      admissionState: optionalText(row, 'admission_state') ?? 'unset',
      enabled: asInteger(row, 'enabled') === 1,
      capacityRequests: asInteger(row, 'capacity_requests'),
      reservedRequests: asInteger(row, 'reserved_requests'),
      runtimeReady: row['runtime_ready'] == null ? null : asInteger(row, 'runtime_ready') === 1,
      heartbeatAgeMs:
        row['runtime_heartbeat_at'] == null ? null : now - asInteger(row, 'runtime_heartbeat_at')
    })),
    activityLeases: {
      total: asInteger(leaseRow, 'total'),
      expired: asInteger(leaseRow, 'expired'),
      requestUnits: asInteger(leaseRow, 'request_units')
    },
    connectionReservations: {
      outstanding: asInteger(reservationRow, 'outstanding'),
      lateArrivalDebt: asInteger(reservationRow, 'late_arrival_debt')
    },
    regionalRehomes: {
      active: asInteger(regionalRehomeRow, 'active'),
      awaitingReceipt: asInteger(regionalRehomeRow, 'awaiting_receipt'),
      targetRegistered: asInteger(regionalRehomeRow, 'target_registered'),
      completedLast24Hours: asInteger(regionalRehomeRow, 'completed_last_24_hours'),
      abortedLast24Hours: asInteger(regionalRehomeRow, 'aborted_last_24_hours'),
      oldestActiveAgeMs: oldestActiveAt === null ? null : now - oldestActiveAt
    }
  }
}

export function formatAssignmentInventorySnapshot(
  snapshot: AssignmentInventorySnapshot
): string[] {
  const lines = snapshot.cells.map(
    (cell) =>
      `[orca-relay] cell inventory cellId=${cell.cellId}` +
      ` region=${cell.region}` +
      ` admission=${cell.admissionState} enabled=${cell.enabled}` +
      ` capacity=${cell.capacityRequests} reserved=${cell.reservedRequests}` +
      ` ready=${cell.runtimeReady ?? 'none'}` +
      ` heartbeatAgeMs=${cell.heartbeatAgeMs ?? 'none'}`
  )
  lines.push(
    `[orca-relay] lease inventory leases=${snapshot.activityLeases.total}` +
      ` expiredLeases=${snapshot.activityLeases.expired}` +
      ` leaseRequestUnits=${snapshot.activityLeases.requestUnits}` +
      ` outstandingReservations=${snapshot.connectionReservations.outstanding}` +
      ` lateArrivalDebt=${snapshot.connectionReservations.lateArrivalDebt}`
  )
  lines.push(
    `[orca-relay] regional rehome inventory active=${snapshot.regionalRehomes.active}` +
      ` awaitingReceipt=${snapshot.regionalRehomes.awaitingReceipt}` +
      ` targetRegistered=${snapshot.regionalRehomes.targetRegistered}` +
      ` completedLast24Hours=${snapshot.regionalRehomes.completedLast24Hours}` +
      ` abortedLast24Hours=${snapshot.regionalRehomes.abortedLast24Hours}` +
      ` oldestActiveAgeMs=${snapshot.regionalRehomes.oldestActiveAgeMs ?? 'none'}`
  )
  return lines
}

function asText(row: SqlRow | undefined, column: string): string {
  return String(row?.[column] ?? '')
}

function optionalText(row: SqlRow | undefined, column: string): string | null {
  const value = row?.[column]
  return value == null ? null : String(value)
}

function asInteger(row: SqlRow | undefined, column: string): number {
  return Number(row?.[column] ?? 0)
}

function optionalInteger(row: SqlRow | undefined, column: string): number | null {
  const value = row?.[column]
  return value == null ? null : Number(value)
}
