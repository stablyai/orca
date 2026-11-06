import { createHash } from 'node:crypto'
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { RELAY_DEFAULT_REGION, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { RelayAssignment } from './assignment/assignment-store.js'
import { lockedSelector, registerExistingOnlyCell, requireSelectorMatchesAdmission } from './cell-admission-selector.js'
import type { RelayDatabase, SqlRow } from './database.js'
import { z } from 'zod'
import {
  EdgeAdminUnavailableError,
  edgeLocationHint,
  type EdgeAdmin,
  type EdgeDeviceRow
} from './edge-admin-client.js'

// Hosts the director has moved to the relay edge carry this cell id on their assignment row. The
// relay_cells row exists only so cells resolve the row (a phone of a moved host gets WRONG_CELL,
// never HOST_OFFLINE) and so the admission selector carries it as existing-only. It is never
// enabled, has no capacity, no runtime row, no fence and is never a reserve cell.
export const EDGE_CELL_ID = 'edge'

export type EdgeRelayConfig = {
  cellUrl: string
  // Present: phase 2 (host data in the edge's objects); director → edge admin calls use it.
  adminSigningKey?: Uint8Array
  // Share of hosts (by hash of relayHostId) in the edge cohort, 0-100.
  rolloutPercent: number
  allowHosts: ReadonlySet<string>
  denyHosts: ReadonlySet<string>
  // Regions whose hosts may join the cohort, by the region the host asked for.
  regions: ReadonlySet<RelayRegion>
}

export function edgeCohortBucket(relayHostId: string): number {
  return createHash('sha256').update(`edge-cohort:${relayHostId}`).digest().readUInt32BE(0) % 100
}

// Deny wins, then allow, then region scope and the rollout share.
export function inEdgeCohort(
  config: EdgeRelayConfig,
  relayHostId: string,
  region: RelayRegion | undefined
): boolean {
  if (config.denyHosts.has(relayHostId)) return false
  if (config.allowHosts.has(relayHostId)) return true
  if (!config.regions.has(region ?? RELAY_DEFAULT_REGION)) return false
  return edgeCohortBucket(relayHostId) < config.rolloutPercent
}

// The host still holds units on its old cell (a reservation, splice or migration); moving the row
// now would release them against the wrong cell. Its next ask, after they settle, moves it.
export class EdgeMoveBusyError extends Error {
  constructor() {
    super('relay_edge_move_busy')
  }
}

export const EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS = 2

type Identity = { userId: string; relayHostId: string }

type EpochSource = {
  seatsOf(userId: string, relayHostId: string): Array<{ epoch: number }>
  recentlyLeftOf(userId: string, relayHostId: string, now: number): Array<{ epoch: number }>
  bookingOf(userId: string, relayHostId: string): { epoch: number } | undefined
}

// Highest epoch the director's seat map knows for the host, so an edge epoch is minted above every
// epoch a reserve cell or a phone may already hold.
export function mapEpochFloor(source: EpochSource | undefined, identity: Identity, now: number): number {
  if (!source) return 0
  const known = [
    ...source.seatsOf(identity.userId, identity.relayHostId).map((seat) => seat.epoch),
    ...source.recentlyLeftOf(identity.userId, identity.relayHostId, now).map((entry) => entry.epoch),
    source.bookingOf(identity.userId, identity.relayHostId)?.epoch ?? 0
  ]
  return Math.max(0, ...known)
}

const DEVICE_COLUMNS = [
  'user_id',
  'relay_host_id',
  'relay_device_id',
  'current_hash',
  'current_version',
  'current_expires_at',
  'grace_hash',
  'grace_version',
  'grace_expires_at',
  'revoked_at',
  'updated_at'
] as const
const NUMERIC_DEVICE_COLUMNS = new Set([
  'current_version',
  'current_expires_at',
  'grace_version',
  'grace_expires_at',
  'revoked_at',
  'updated_at'
])
const millis = z.number().int().nonnegative()
const ExportedDeviceSchema = z
  .object({
    user_id: z.string().min(1),
    relay_host_id: z.string(),
    relay_device_id: z.string().min(1).max(128),
    current_hash: z.string().min(1).max(256),
    current_version: millis,
    current_expires_at: millis,
    grace_hash: z.string().min(1).max(256).nullable(),
    grace_version: millis.nullable(),
    grace_expires_at: millis.nullable(),
    revoked_at: millis.nullable(),
    updated_at: millis
  })
  .strict()

export class EdgeAssignments {
  private seeded = false

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
    if (!this.seeded) return null
    const row = (
      await this.database.query(
        `SELECT cell_id, assignment_epoch, lease_expires_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    if (!row || text(row, 'cell_id') !== EDGE_CELL_ID) return null
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
        if (error instanceof Error && error.message === 'database_lock_unavailable') throw new EdgeMoveBusyError()
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
        if (!winner || text(winner, 'cell_id') !== EDGE_CELL_ID) throw new EdgeMoveBusyError()
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
      if (requestUnits(row) > 0) throw new EdgeMoveBusyError()
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
    if (!this.admin) return epoch
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
        result = await this.admin.assign({
          ...identity,
          cellId: EDGE_CELL_ID,
          assignmentEpoch,
          devices,
          locationHint: edgeLocationHint(region)
        })
      } catch (error) {
        if (error instanceof EdgeAdminUnavailableError) throw new EdgeMoveBusyError()
        throw error
      }
      if (result.outcome === 'applied' || result.outcome === 'unchanged') return assignmentEpoch
      assignmentEpoch = Math.max(assignmentEpoch, result.assignmentEpoch) + 1
      await transaction.query(
        `UPDATE relay_assignments SET assignment_epoch = ? WHERE user_id = ? AND relay_host_id = ?`,
        [assignmentEpoch, identity.userId, identity.relayHostId]
      )
    }
    throw new EdgeMoveBusyError()
  }

  // A host on the edge is about to be placed elsewhere (cohort off, rollback): first take its
  // devices back. The edge refuses while the desktop is connected and otherwise freezes the host
  // (30 s), so nothing changes after the snapshot. Returns false when the host is not on the edge.
  async leaveEdge(identity: Identity): Promise<boolean> {
    if (!this.seeded || !this.admin) return false
    const row = (
      await this.database.query(
        `SELECT cell_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    if (!row || text(row, 'cell_id') !== EDGE_CELL_ID) return false
    let exported
    try {
      exported = await this.admin.exportHost(identity.relayHostId)
    } catch (error) {
      if (error instanceof EdgeAdminUnavailableError) throw new EdgeMoveBusyError()
      throw error
    }
    if (exported.outcome === 'busy') throw new EdgeMoveBusyError()
    // An object with no assignment never held this host's data (or was erased): keep Postgres.
    if (!exported.assignment) return true
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

  // After the host left: tell the edge where it went, so its phones get WRONG_CELL (re-resolve)
  // rather than HOST_OFFLINE. Best effort; until it lands the edge's freeze does the same, and after
  // that its phones see HOST_OFFLINE until the next move.
  async fenceAway(identity: Identity, cellId: string, assignmentEpoch: number): Promise<boolean> {
    if (!this.admin) return true
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.admin.assign({ ...identity, cellId, assignmentEpoch })
        if (result.outcome !== 'conflict') return true
      } catch (error) {
        if (!(error instanceof EdgeAdminUnavailableError)) throw error
      }
    }
    console.error(JSON.stringify({ event: 'orca_relay_edge_fence_failed', cellId, assignmentEpoch }))
    return false
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

function requestUnits(row: SqlRow): number {
  return (
    integer(row, 'reserved_controls') +
    2 * integer(row, 'reserved_splices') +
    integer(row, 'reserved_invites') +
    integer(row, 'pending_installs') +
    integer(row, 'pending_confirmations') +
    integer(row, 'migration_leases')
  )
}

function deviceRow(row: SqlRow): EdgeDeviceRow {
  const out: Record<string, unknown> = {}
  for (const column of DEVICE_COLUMNS) {
    const value = row[column]
    out[column] =
      value === null || value === undefined
        ? null
        : NUMERIC_DEVICE_COLUMNS.has(column)
          ? integer(row, column)
          : value
  }
  return out as EdgeDeviceRow
}

function integer(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new Error(`invalid_${field}`)
  return value
}

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`invalid_${field}`)
  return value
}
