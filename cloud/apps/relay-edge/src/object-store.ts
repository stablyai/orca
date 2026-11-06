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
export type AssignOutcome = 'applied' | 'unchanged' | 'stale'

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
    return a !== null && a.userId === userId && a.relayHostId === relayHostId && a.cellId === this.cellId && a.assignmentEpoch === assignmentEpoch
  }

  async assignedElsewhere(userId: string, relayHostId: string): Promise<boolean> {
    const a = this.assignment()
    return a !== null && a.userId === userId && a.relayHostId === relayHostId && a.cellId !== this.cellId
  }

  // Epochs only move forward. A host that moves onto the edge brings its full device set, which
  // replaces the object's (the director exported the edge's set back before any earlier move away).
  async applyAssignment(body: AssignBody, now = Date.now()): Promise<AssignOutcome> {
    return this.runTransaction(async () => {
      const current = this.assignment()
      if (current && current.relayHostId !== body.relayHostId) throw new Error('edge_assignment_host_mismatch')
      if (current && body.assignmentEpoch < current.assignmentEpoch) return 'stale'
      if (current && body.assignmentEpoch === current.assignmentEpoch) {
        // A retried push. Same epoch must mean the same placement.
        if (current.cellId !== body.cellId || current.userId !== body.userId) throw new Error('edge_assignment_epoch_conflict')
        return 'unchanged'
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
      if (body.cellId === this.cellId && body.devices) this.replaceDevices(body.relayHostId, body.devices)
      return 'applied'
    })
  }

  private replaceDevices(relayHostId: string, devices: DeviceRow[]): void {
    this.sql.exec('DELETE FROM relay_devices WHERE relay_host_id = ?', relayHostId)
    const marks = DEVICE_COLUMNS.map(() => '?').join(', ')
    for (const device of devices) {
      this.sql.exec(`INSERT INTO relay_devices (${DEVICE_COLUMNS.join(', ')}) VALUES (${marks})`, ...DEVICE_COLUMNS.map((c) => device[c]))
    }
  }

  // What the director writes back to Postgres before moving the host away.
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
