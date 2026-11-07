// Phase 2 per-host storage inside HostRelay: the credential store's tables (object-database.ts)
// plus the assignment the director pushed. One object = one relayHostId, so every row here
// belongs to that host.
import type { AssignmentSource } from './edge-backend'
import type { AssignBody, DeviceRow } from './admin'
import { ObjectSqliteDatabase, type ObjectSql, type RunTransaction } from './object-database'
import { OBJECT_STORE_SCHEMA } from './object-store-schema.generated'

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

// Every table an object holds. Changing any of it (including a regenerated credential-store
// schema) needs OBJECT_SCHEMA_VERSION bumped and the step in MIGRATIONS: existing objects keep
// their old tables, because CREATE TABLE IF NOT EXISTS never alters them.
// test/object-store-schema.test.ts pins the version to a hash of this DDL.
export const OBJECT_SCHEMA_VERSION = 1
export const MIGRATIONS: Readonly<Record<number, readonly string[]>> = {}
const META_DDL = `CREATE TABLE IF NOT EXISTS edge_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL
)`
export const OBJECT_DDL: readonly string[] = [...OBJECT_STORE_SCHEMA, ASSIGNMENT_DDL, MOVE_DDL]

// Everything the credential store keeps for the host. A host moving onto the edge brings its
// devices; invites, bases, results and audit rows from an earlier stay (possibly another account
// on the same machine: the object is per relayHostId) are void.
const HOST_DATA_TABLES = [
  'relay_audit_events',
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
    openSchema(sql)
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

  assignmentUpdatedAt(): number | null {
    const row = this.sql.exec('SELECT updated_at FROM edge_assignment WHERE id = 1').toArray()[0]
    return row ? Number(row.updated_at) : null
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

  // Erasure guard, as today's: no live phone session basis may remain. Readers reject a basis past
  // its deadline whatever its flag, so only unexpired ones count (a reset splice never clears its own).
  activeBases(now = Date.now()): number {
    return Number(
      this.sql.exec('SELECT count(*) AS n FROM relay_connection_bases WHERE active = 1 AND deadline > ?', now).toArray()[0]?.n ?? 0
    )
  }
}

// Synchronous, so the object commits it as one write batch. Version 0 is a fresh object, or one
// from before versioning (it holds version 1's tables). Code older than the object's schema (a
// rolled-back deploy) refuses it: callers answer 4503 or a failed push, never a wrong read.
export function openSchema(sql: ObjectSql): void {
  sql.exec(META_DDL)
  const stored = Number(sql.exec('SELECT schema_version FROM edge_meta WHERE id = 1').toArray()[0]?.schema_version ?? 0)
  if (stored === OBJECT_SCHEMA_VERSION) return
  if (stored > OBJECT_SCHEMA_VERSION) throw new Error('edge_object_schema_newer')
  if (stored === 0) {
    for (const statement of OBJECT_DDL) sql.exec(statement)
  } else {
    for (let v = stored + 1; v <= OBJECT_SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v]
      if (!step) throw new Error(`edge_object_schema_no_migration_${v}`)
      for (const statement of step) sql.exec(statement)
    }
  }
  sql.exec('INSERT INTO edge_meta (id, schema_version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET schema_version = excluded.schema_version', OBJECT_SCHEMA_VERSION)
}
