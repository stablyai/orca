// Phase 2 per-host storage inside HostRelay: the credential store's tables (object-database.ts)
// plus the assignment the director pushed. One object = one relayHostId, so every row here
// belongs to that host.
import type { AssignmentSource } from './edge-backend'
import type { AssignBody, DeviceRow } from './admin'
import { ObjectSqliteDatabase, type ObjectSql, type RunTransaction } from './object-database'

const ASSIGNMENT_DDL = `CREATE TABLE IF NOT EXISTS edge_assignment (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

// Set by an export (the director is moving the host away): until it lapses or a push lands, the
// host's hello and its phones are told WRONG_CELL, so nothing can change after the snapshot. A
// director that dies mid-move leaves the host where its row still says, once this lapses.
const MOVE_DDL = `CREATE TABLE IF NOT EXISTS edge_move (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  frozen_until INTEGER NOT NULL
)`
export const EXPORT_FREEZE_MS = 30_000

// Everything the credential store keeps for the host, except the audit trail. A host moving onto
// the edge brings its devices; invites, bases and command results from an earlier stay are void.
const HOST_DATA_TABLES = [
  'relay_devices',
  'relay_invites',
  'relay_connection_bases',
  'relay_direct_authorizations',
  'relay_install_results',
  'relay_confirm_results',
  'relay_rate_windows'
] as const

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

export type StoredAssignment = { userId: string; relayHostId: string; cellId: string; assignmentEpoch: number }
export type AssignOutcome = 'applied' | 'unchanged' | 'stale' | 'conflict'
export type AssignResult = { outcome: AssignOutcome; assignmentEpoch: number }

export class ObjectStore implements AssignmentSource {
  readonly database: ObjectSqliteDatabase

  constructor(
    private readonly sql: ObjectSql,
    private readonly runTransaction: RunTransaction,
    private readonly cellId: string
  ) {
    this.database = new ObjectSqliteDatabase(sql, runTransaction)
    this.database.applySchema()
    sql.exec(ASSIGNMENT_DDL)
    sql.exec(MOVE_DDL)
  }

  frozen(now = Date.now()): boolean {
    const row = this.sql.exec('SELECT frozen_until FROM edge_move WHERE id = 1').toArray()[0]
    return row !== undefined && Number(row.frozen_until) > now
  }

  assignment(): StoredAssignment | null {
    const row = this.sql.exec('SELECT user_id, relay_host_id, cell_id, assignment_epoch FROM edge_assignment WHERE id = 1').toArray()[0]
    if (!row) return null
    return {
      userId: String(row.user_id),
      relayHostId: String(row.relay_host_id),
      cellId: String(row.cell_id),
      assignmentEpoch: Number(row.assignment_epoch)
    }
  }

  async verifyAssignment(userId: string, relayHostId: string, assignmentEpoch: number): Promise<boolean> {
    const a = this.assignment()
    if (this.frozen()) return false
    return a !== null && a.userId === userId && a.relayHostId === relayHostId && a.cellId === this.cellId && a.assignmentEpoch === assignmentEpoch
  }

  async assignedElsewhere(userId: string, relayHostId: string): Promise<boolean> {
    const a = this.assignment()
    return a !== null && a.userId === userId && a.relayHostId === relayHostId && (a.cellId !== this.cellId || this.frozen())
  }

  // Epochs only move forward. A host that moves onto the edge brings its full device set, which
  // replaces the object's host data (the director exported the edge's set before any move away).
  // Stale and conflict answers carry the edge's epoch so the director can mint above it.
  async applyAssignment(body: AssignBody, now = Date.now()): Promise<AssignResult> {
    return this.runTransaction(async () => {
      const current = this.assignment()
      if (current && current.relayHostId !== body.relayHostId) throw new Error('edge_assignment_host_mismatch')
      if (current && body.assignmentEpoch < current.assignmentEpoch) return { outcome: 'stale', assignmentEpoch: current.assignmentEpoch }
      if (current && body.assignmentEpoch === current.assignmentEpoch) {
        // A retried push. Same epoch must mean the same placement.
        if (current.cellId !== body.cellId || current.userId !== body.userId) {
          return { outcome: 'conflict', assignmentEpoch: current.assignmentEpoch }
        }
        // The move's first push may have landed without the director committing; its retry
        // carries the snapshot again. The director never re-pushes once the host is live here.
        if (body.cellId === this.cellId && body.devices) this.replaceHostData(body.devices)
        this.sql.exec('DELETE FROM edge_move')
        return { outcome: 'unchanged', assignmentEpoch: current.assignmentEpoch }
      }
      this.sql.exec(
        `INSERT INTO edge_assignment (id, user_id, relay_host_id, cell_id, assignment_epoch, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, relay_host_id = excluded.relay_host_id,
           cell_id = excluded.cell_id, assignment_epoch = excluded.assignment_epoch, updated_at = excluded.updated_at`,
        body.userId,
        body.relayHostId,
        body.cellId,
        body.assignmentEpoch,
        now
      )
      if (body.cellId === this.cellId && body.devices) this.replaceHostData(body.devices)
      this.sql.exec('DELETE FROM edge_move')
      return { outcome: 'applied', assignmentEpoch: body.assignmentEpoch }
    })
  }

  // The director's move away, step 1: freeze, then snapshot. The caller refuses while the host's
  // control is live (only a live host can change devices).
  freezeForExport(now = Date.now()): DeviceRow[] {
    this.sql.exec(
      'INSERT INTO edge_move (id, frozen_until) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET frozen_until = excluded.frozen_until',
      now + EXPORT_FREEZE_MS
    )
    return this.exportDevices()
  }

  private replaceHostData(devices: DeviceRow[]): void {
    for (const table of HOST_DATA_TABLES) this.sql.exec(`DELETE FROM ${table}`)
    const marks = DEVICE_COLUMNS.map(() => '?').join(', ')
    for (const device of devices) {
      this.sql.exec(`INSERT INTO relay_devices (${DEVICE_COLUMNS.join(', ')}) VALUES (${marks})`, ...DEVICE_COLUMNS.map((c) => device[c]))
    }
  }

  // Read-only snapshot (tests, erasure checks).
  exportDevices(): DeviceRow[] {
    return this.sql
      .exec(`SELECT ${DEVICE_COLUMNS.join(', ')} FROM relay_devices ORDER BY relay_device_id`)
      .toArray()
      .map((row) => {
        const out: Record<string, unknown> = {}
        for (const c of DEVICE_COLUMNS) out[c] = row[c] === null || typeof row[c] === 'string' ? row[c] : Number(row[c])
        return out as DeviceRow
      })
  }

  // Erasure guard, as today's: no live phone session basis may remain.
  activeBases(): number {
    return Number(this.sql.exec('SELECT count(*) AS n FROM relay_connection_bases WHERE active = 1').toArray()[0]?.n ?? 0)
  }
}
