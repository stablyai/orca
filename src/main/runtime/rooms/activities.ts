import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomAgentActivity } from '../../../shared/rooms'

type ActivityRow = { activity_json: string }

export function ensureRoomActivitySchema(db: SyncDatabase.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_agent_activity (
      participant_id TEXT PRIMARY KEY REFERENCES room_participants(id) ON DELETE CASCADE,
      activity_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

export class RoomActivityStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  list(roomId: string): RoomAgentActivity[] {
    const rows = this.db
      .prepare(
        `SELECT activity_json
         FROM room_agent_activity
         WHERE participant_id IN (SELECT id FROM room_participants WHERE room_id = ?)
         ORDER BY updated_at`
      )
      .all(roomId) as ActivityRow[]
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.activity_json) as RoomAgentActivity]
      } catch {
        return []
      }
    })
  }

  get(participantId: string): RoomAgentActivity | null {
    const row = this.db
      .prepare('SELECT activity_json FROM room_agent_activity WHERE participant_id = ?')
      .get(participantId) as ActivityRow | undefined
    if (!row) {
      return null
    }
    try {
      return JSON.parse(row.activity_json) as RoomAgentActivity
    } catch {
      return null
    }
  }

  upsert(activity: RoomAgentActivity): void {
    this.db
      .prepare(
        `INSERT INTO room_agent_activity (participant_id, activity_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(participant_id) DO UPDATE SET
           activity_json = excluded.activity_json,
           updated_at = excluded.updated_at`
      )
      .run(activity.participantId, JSON.stringify(activity), activity.updatedAt)
  }

  remove(participantId: string): void {
    this.db.prepare('DELETE FROM room_agent_activity WHERE participant_id = ?').run(participantId)
  }
}
