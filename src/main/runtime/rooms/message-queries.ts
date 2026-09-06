import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomMessage, RoomUnread } from '../../../shared/rooms'
import { attachmentFromRow, messageFromRow, type RoomRow } from './rows'

const RELATED_MESSAGE_BATCH_SIZE = 500

export function hydrateRoomMessages(db: SyncDatabase.Database, rows: RoomRow[]): RoomMessage[] {
  if (rows.length === 0) {
    return []
  }
  const ids = rows.map((row) => String(row.id))
  const relatedRows = (table: 'room_message_mentions' | 'room_attachments'): RoomRow[] => {
    const related: RoomRow[] = []
    for (let offset = 0; offset < ids.length; offset += RELATED_MESSAGE_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + RELATED_MESSAGE_BATCH_SIZE)
      related.push(
        ...(db
          .prepare(
            `SELECT * FROM ${table} WHERE message_id IN (${batch.map(() => '?').join(', ')})${
              table === 'room_message_mentions' ? ' ORDER BY message_id, position, rowid' : ''
            }`
          )
          .all(...batch) as RoomRow[])
      )
    }
    return related
  }
  const mentionRows = relatedRows('room_message_mentions')
  const attachmentRows = relatedRows('room_attachments')
  const mentions = new Map<string, string[]>()
  const attachments = new Map<string, ReturnType<typeof attachmentFromRow>[]>()
  for (const row of mentionRows) {
    const id = String(row.message_id)
    const values = mentions.get(id) ?? []
    values.push(String(row.identity))
    mentions.set(id, values)
  }
  for (const row of attachmentRows) {
    const id = String(row.message_id)
    const values = attachments.get(id) ?? []
    values.push(attachmentFromRow(row))
    attachments.set(id, values)
  }
  return rows.map((row) => {
    const id = String(row.id)
    return messageFromRow(row, mentions.get(id) ?? [], attachments.get(id) ?? [])
  })
}

export function getRoomUnread(
  db: SyncDatabase.Database,
  roomId: string,
  readerKey: string
): RoomUnread {
  const row = db
    .prepare(
      `SELECT rooms.id AS room_id, coalesce(r.last_read_sequence, 0) AS last_read_sequence,
        count(m.sequence) AS unread_count
       FROM rooms
       LEFT JOIN room_reads r ON r.room_id = rooms.id AND r.reader_key = ?
       LEFT JOIN room_messages m ON m.room_id = rooms.id
         AND m.sequence > coalesce(r.last_read_sequence, 0) AND m.deleted_at IS NULL
       WHERE rooms.id = ? GROUP BY rooms.id, r.last_read_sequence`
    )
    .get(readerKey, roomId) as RoomRow | undefined
  if (!row) {
    throw new Error('room_not_found')
  }
  return {
    roomId: String(row.room_id),
    unreadCount: Number(row.unread_count),
    lastReadSequence: Number(row.last_read_sequence)
  }
}
