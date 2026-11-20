import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import type { RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { RelayAssignment } from './assignment/assignment-store.js'
import { lockedSelector, registerExistingOnlyCell, requireSelectorMatchesAdmission } from './cell/admission/cell-admission-selector.js'
import type { RelayDatabase, SqlRow } from './database/database.js'
import {
  EDGE_ADMIN_LOCKED_TIMEOUT_MS,
  EdgeAdminUnavailableError,
  edgeLocationHint,
  type EdgeAdmin,
  type EdgeAssignBody,
  type EdgeAssignResult
} from './edge-admin-client.js'
import { fenceEdge } from './edge-relay-fence.js'
import {
  EDGE_EXPORT_FAILURE_GAP_MS,
  EDGE_LOCKED_CALLS_MAX,
  DEVICE_COLUMNS,
  EDGE_EXPORT_SKIP_AFTER_MS,
  EdgeMoveBusyError,
  EdgeMoveDeferredError,
  ExportedDeviceSchema,
  deviceRow,
  integer,
  requestUnits,
  text,
  type EdgeRelayConfig,
  type Identity
} from './edge-relay-cohort.js'

export {
  EDGE_EXPORT_SKIP_AFTER_MS,
  EDGE_LOCKED_CALLS_MAX,
  EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS,
  EdgeMoveBusyError,
  EdgeMoveDeferredError,
  edgeCohortBucket,
  inEdgeCohort,
  mapEpochFloor,
  mayBeOnEdge,
  type EdgeRelayConfig
} from './edge-relay-cohort.js'

// Hosts the director has moved to the relay edge carry this cell id on their assignment row. The
// relay_cells row exists only so cells resolve the row (a phone of a moved host gets WRONG_CELL,
// never HOST_OFFLINE) and so the admission selector carries it as existing-only. It is never
// enabled, has no capacity, no runtime row, no fence and is never a reserve cell.
export const EDGE_CELL_ID = 'edge'

export class EdgeAssignments {
  private seeded = false
  // When this director's exports started failing as unavailable; any usable answer clears it.
  private exportFailingSince: number | undefined
  private exportLastFailureAt: number | undefined
  // Edge admin calls in flight under an assignment row lock (pushes), capped at EDGE_LOCKED_CALLS_MAX.
  private lockedCalls = 0

  // With `admin` (the edge keeps host data in its objects) every move onto the edge pushes the
  // host's devices before the answer, and every move off exports them back first.
  constructor(
    private readonly database: RelayDatabase,
    readonly config: EdgeRelayConfig,
    private readonly now: () => number = Date.now,
    private readonly admin?: EdgeAdmin
  ) {}

  get pushes(): boolean {
    return this.admin !== undefined
  }

  // The override answers nothing until the edge row is registered; before that a moved host's
  // phones would find no cell row and be told HOST_OFFLINE forever.
  get ready(): boolean {
    return this.seeded
  }

  async ensureEdgeCell(): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
      // Row locks do not stop another director inserting the same new key; the selector row
      // lock serializes concurrent seeds, and the insert below tolerates a lost race anyway.
      const selector = await lockedSelector(transaction)
      const existing = (
        await transaction.query(`SELECT cell_url FROM relay_cells WHERE cell_id = ?`, [EDGE_CELL_ID])
      )[0]
      if (!existing) {
        // Refuse to add to a selector that already drifted; the roll that owns it must settle first.
        await requireSelectorMatchesAdmission(transaction, selector)
        await transaction.query(
          `INSERT INTO relay_cells
           (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
            observed_requests, last_heartbeat_at, updated_at)
           VALUES (?, ?, 0, 0, 0, 0, ?, ?)
           ON CONFLICT (cell_id) DO NOTHING`,
          [EDGE_CELL_ID, this.config.cellUrl, now, now]
        )
      } else if (text(existing, 'cell_url') !== this.config.cellUrl) {
        await transaction.query(`UPDATE relay_cells SET cell_url = ?, updated_at = ? WHERE cell_id = ?`, [
          this.config.cellUrl,
          now,
          EDGE_CELL_ID
        ])
      }
      await registerExistingOnlyCell(transaction, EDGE_CELL_ID, now)
    })
    this.seeded = true
  }

  // Phone paths (/v1/resolve, the invite move): answer a host that is on the edge without moving
  // anything. The director's liveness rule would otherwise read the edge row as "no answer" and
  // re-place the host on a cell it is not connected to.
  async edgeAssignment(identity: Identity): Promise<RelayAssignment | null> {
    if (!this.seeded) { return null }
    const row = (
      await this.database.query(
        `SELECT cell_id, assignment_epoch, lease_expires_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    if (!row || text(row, 'cell_id') !== EDGE_CELL_ID) { return null }
    return this.answer(identity, integer(row, 'assignment_epoch'), integer(row, 'lease_expires_at'))
  }

  // The host's own ask: moves its row to the edge, minting a strictly newer epoch only when the cell
  // changes (phones accept a move only with a newer epoch; re-asks must not flap the epoch).
  async moveToEdge(identity: Identity, mapFloor: number, region?: RelayRegion): Promise<RelayAssignment> {
    const now = this.now()
    const leaseExpiresAt = now + ASSIGNMENT_LIMITS.activityLeaseMs
    return await this.database.transaction(async (transaction) => {
      let rows: SqlRow[]
      try {
        rows = await transaction.queryLocked(
          `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
          [identity.userId, identity.relayHostId],
          { failIfUnavailable: true }
        )
      } catch (error) {
        if (error instanceof Error && error.message === 'database_lock_unavailable') { throw new EdgeMoveBusyError() }
        throw error
      }
      const row = rows[0]
      if (!row) {
        const epoch = mapFloor + 1
        // A missing row locks nothing: a concurrent first ask may insert it first. The loser
        // answers the winner's row, so both asks return one epoch.
        const inserted = await transaction.query(
          `INSERT INTO relay_assignments
           (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
            reserved_controls, reserved_splices, reserved_invites, pending_installs,
            pending_confirmations, migration_leases)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
           ON CONFLICT (user_id, relay_host_id) DO NOTHING
           RETURNING assignment_epoch`,
          [identity.userId, identity.relayHostId, EDGE_CELL_ID, epoch, leaseExpiresAt, now]
        )
        if (inserted.length === 1) {
          const pushed = await this.pushOnto(transaction, identity, epoch, region)
          return this.answer(identity, pushed, leaseExpiresAt)
        }
        const winner = (
          await transaction.query(
            `SELECT cell_id, assignment_epoch, lease_expires_at FROM relay_assignments
             WHERE user_id = ? AND relay_host_id = ?`,
            [identity.userId, identity.relayHostId]
          )
        )[0]
        if (!winner || text(winner, 'cell_id') !== EDGE_CELL_ID) { throw new EdgeMoveBusyError() }
        return this.answer(identity, integer(winner, 'assignment_epoch'), integer(winner, 'lease_expires_at'))
      }
      if (text(row, 'cell_id') === EDGE_CELL_ID) {
        await transaction.query(
          `UPDATE relay_assignments SET lease_expires_at = ?, last_activity_at = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [leaseExpiresAt, now, identity.userId, identity.relayHostId]
        )
        return this.answer(identity, integer(row, 'assignment_epoch'), leaseExpiresAt)
      }
      if (requestUnits(row) > 0) { throw new EdgeMoveDeferredError('units_held') }
      const epoch = Math.max(integer(row, 'assignment_epoch'), mapFloor) + 1
      await transaction.query(
        `UPDATE relay_assignments
         SET cell_id = ?, assignment_epoch = ?, lease_expires_at = ?, last_activity_at = ?
         WHERE user_id = ? AND relay_host_id = ?`,
        [EDGE_CELL_ID, epoch, leaseExpiresAt, now, identity.userId, identity.relayHostId]
      )
      // Still under the row lock: the row commits only once the edge holds the host's data.
      const pushed = await this.pushOnto(transaction, identity, epoch, region)
      console.warn(
        JSON.stringify({
          event: 'orca_relay_edge_moved',
          fromCellId: text(row, 'cell_id'),
          assignmentEpoch: pushed
        })
      )
      return this.answer(identity, pushed, leaseExpiresAt)
    })
  }

  // Pushes the row just written (epoch `epoch`, still uncommitted) with the host's devices. An edge
  // that already holds a newer or different epoch (an earlier push whose move never committed)
  // names it; the row is re-minted above it once. Any failure rolls the move back (503, retry).
  private async pushOnto(
    transaction: RelayDatabase,
    identity: Identity,
    epoch: number,
    region: RelayRegion | undefined
  ): Promise<number> {
    if (!this.admin) { return epoch }
    const devices = (
      await transaction.query(
        `SELECT ${DEVICE_COLUMNS.join(', ')} FROM relay_devices
         WHERE user_id = ? AND relay_host_id = ? ORDER BY relay_device_id`,
        [identity.userId, identity.relayHostId]
      )
    ).map(deviceRow)
    let assignmentEpoch = epoch
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result
      try {
        result = await this.lockedAssign({
          ...identity,
          cellId: EDGE_CELL_ID,
          assignmentEpoch,
          devices,
          locationHint: edgeLocationHint(region)
        })
      } catch (error) {
        if (error instanceof EdgeAdminUnavailableError) { throw new EdgeMoveDeferredError('push_failed') }
        throw error
      }
      if (result.outcome === 'applied' || result.outcome === 'unchanged') { return assignmentEpoch }
      assignmentEpoch = Math.max(assignmentEpoch, result.assignmentEpoch) + 1
      await transaction.query(
        `UPDATE relay_assignments SET assignment_epoch = ? WHERE user_id = ? AND relay_host_id = ?`,
        [assignmentEpoch, identity.userId, identity.relayHostId]
      )
    }
    throw new EdgeMoveDeferredError('push_failed')
  }

  // A push made under the row lock. Past EDGE_LOCKED_CALLS_MAX in flight the move is deferred at
  // once rather than adding another row lock held on a slow edge.
  private async lockedAssign(body: EdgeAssignBody): Promise<EdgeAssignResult> {
    if (!this.admin) { throw new Error('relay_edge_admin_missing') }
    if (this.lockedCalls >= EDGE_LOCKED_CALLS_MAX) { throw new EdgeMoveDeferredError('edge_busy') }
    this.lockedCalls += 1
    try {
      return await this.admin.assign(body, { timeoutMs: EDGE_ADMIN_LOCKED_TIMEOUT_MS })
    } finally {
      this.lockedCalls -= 1
    }
  }

  // A host on the edge is about to be placed elsewhere (cohort off, rollback): first take its
  // devices back. The edge refuses while the desktop is connected and otherwise freezes the host
  // (30 s), so nothing changes after the snapshot. Returns false when the host is not on the edge.
  async leaveEdge(identity: Identity): Promise<boolean> {
    if (!this.seeded || !this.admin) { return false }
    const row = (
      await this.database.query(
        `SELECT cell_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    if (!row || text(row, 'cell_id') !== EDGE_CELL_ID) { return false }
    // The edge is known dead (director/edge.json): no export to wait for.
    if (this.config.control?.().mode === 'down') { return await this.skipExport(identity, 'mode_down') }
    let exported
    try {
      exported = await this.admin.exportHost(identity.relayHostId)
    } catch (error) {
      if (!(error instanceof EdgeAdminUnavailableError)) { throw error }
      const now = this.now()
      // Only continuous failures count: a gap longer than EDGE_EXPORT_FAILURE_GAP_MS (desktops retry
      // every 2 s) starts the clock again, so one old failure cannot skip an export on its own.
      if (this.exportLastFailureAt === undefined || now - this.exportLastFailureAt > EDGE_EXPORT_FAILURE_GAP_MS) {
        this.exportFailingSince = now
      }
      this.exportLastFailureAt = now
      const failingForMs = now - (this.exportFailingSince ?? now)
      if (failingForMs < (this.config.exportSkipAfterMs ?? EDGE_EXPORT_SKIP_AFTER_MS)) { throw new EdgeMoveBusyError() }
      // The edge has been unreachable too long: place the host anyway rather than refusing every
      // ask until the edge is back.
      return await this.skipExport(identity, error.message, failingForMs)
    }
    this.exportFailingSince = undefined
    this.exportLastFailureAt = undefined
    if (exported.outcome === 'busy') { throw new EdgeMoveBusyError() }
    // An object with no assignment never held this host's data (or was erased): keep Postgres.
    if (!exported.assignment) { return true }
    const devices = exported.devices.map((device) => {
      const parsed = ExportedDeviceSchema.parse(device)
      if (parsed.user_id !== identity.userId || parsed.relay_host_id !== identity.relayHostId) {
        throw new Error('relay_edge_export_foreign_device')
      }
      return parsed
    })
    // The edge is the source of truth while the host is there: replace, so revokes carry over.
    await this.database.transaction(async (transaction) => {
      await transaction.query(`DELETE FROM relay_devices WHERE user_id = ? AND relay_host_id = ?`, [
        identity.userId,
        identity.relayHostId
      ])
      for (const device of devices) {
        await transaction.query(
          `INSERT INTO relay_devices (${DEVICE_COLUMNS.join(', ')})
           VALUES (${DEVICE_COLUMNS.map(() => '?').join(', ')})`,
          DEVICE_COLUMNS.map((column) => device[column])
        )
      }
    })
    console.warn(JSON.stringify({ event: 'orca_relay_edge_exported', devices: devices.length }))
    return true
  }

  // The host leaves without the edge's copy of its devices. The edge was their source of truth and
  // revokes made there are unknown, so the Postgres rows are removed rather than resurrected: its
  // phones pair again. Logs a count only.
  private async skipExport(identity: Identity, reason: string, failingForMs?: number): Promise<true> {
    const removed = await this.database.query(
      `DELETE FROM relay_devices WHERE user_id = ? AND relay_host_id = ? RETURNING relay_device_id`,
      [identity.userId, identity.relayHostId]
    )
    console.warn(
      JSON.stringify({
        event: 'orca_relay_edge_export_skipped',
        reason,
        ...(failingForMs === undefined ? {} : { failingForMs }),
        devicesRemoved: removed.length
      })
    )
    return true
  }

  // After the host left: tell the edge where it went, so its phones get WRONG_CELL (re-resolve)
  // rather than HOST_OFFLINE. Until it lands the edge's freeze does the same; one that does not land
  // is recorded for the evacuation sweep to retry (edge-relay-fence.ts).
  async fenceAway(identity: Identity, cellId: string, assignmentEpoch: number): Promise<boolean> {
    if (!this.admin) { return true }
    // An edge whose exports are failing (or that is marked down) gets one try, so a skipped export
    // is not slowed further.
    const down = this.exportFailingSince !== undefined || this.config.control?.().mode === 'down'
    const attempts = down ? 1 : 3
    return await fenceEdge(this.database, this.admin, { ...identity, cellId, assignmentEpoch }, attempts, this.now())
  }

  private answer(identity: Identity, assignmentEpoch: number, leaseExpiresAt: number): RelayAssignment {
    return {
      ...identity,
      cellId: EDGE_CELL_ID,
      cellUrl: this.config.cellUrl,
      assignmentEpoch,
      leaseExpiresAt
    }
  }
}
