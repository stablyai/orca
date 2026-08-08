import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomPin, RoomPinStatus } from '../../../shared/rooms'
import { pinFromRow, type RoomRow } from './rows'

export class RoomPinStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  list(roomId: string): RoomPin[] {
    return (
      this.db
        .prepare('SELECT * FROM room_pins WHERE room_id = ? ORDER BY status, created_at DESC')
        .all(roomId) as RoomRow[]
    ).map(pinFromRow)
  }

  set(input: {
    roomId: string
    messageId: string
    status: RoomPinStatus
    createdBy: string
  }): RoomPin {
    const message = this.db
      .prepare('SELECT 1 FROM room_messages WHERE id = ? AND room_id = ?')
      .get(input.messageId, input.roomId)
    if (!message) {
      throw new Error('room_pin_message_invalid')
    }
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO room_pins
         (room_id, message_id, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, message_id) DO UPDATE SET
           status = excluded.status, updated_at = excluded.updated_at`
      )
      .run(input.roomId, input.messageId, input.status, input.createdBy, now, now)
    const row = this.db
      .prepare('SELECT * FROM room_pins WHERE room_id = ? AND message_id = ?')
      .get(input.roomId, input.messageId) as RoomRow
    return pinFromRow(row)
  }

  remove(roomId: string, messageId: string): void {
    if (
      this.db
        .prepare('DELETE FROM room_pins WHERE room_id = ? AND message_id = ?')
        .run(roomId, messageId).changes === 0
    ) {
      throw new Error('room_pin_not_found')
    }
  }
}
