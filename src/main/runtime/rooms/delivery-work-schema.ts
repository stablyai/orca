import type SyncDatabase from '../../sqlite/sync-database'

export function ensureRoomDeliveryWorkSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(rooms)') as { name: string }[]
  if (!columns.some((column) => column.name === 'delivery_queue_stopped')) {
    db.exec(
      `ALTER TABLE rooms ADD COLUMN delivery_queue_stopped INTEGER NOT NULL DEFAULT 0
       CHECK(delivery_queue_stopped IN (0, 1))`
    )
  }
  db.exec(`
    UPDATE rooms SET delivery_queue_stopped = 1 WHERE EXISTS (
      SELECT 1 FROM room_deliveries d JOIN room_messages m ON m.id = d.message_id
      WHERE m.room_id = rooms.id AND d.state = 'suppressed'
        AND d.error IN ('room_stopped', 'room_stopping')
    )
  `)
}
