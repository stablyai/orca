import type SyncDatabase from '../../sqlite/sync-database'

export function ensureRoomMessageDeliveryAttemptSchema(db: SyncDatabase.Database): void {
  const columns = db.pragma('table_info(room_messages)') as { name: string }[]
  if (!columns.some((column) => column.name === 'delivery_attempted')) {
    db.exec(
      `ALTER TABLE room_messages ADD COLUMN delivery_attempted INTEGER NOT NULL DEFAULT 0
       CHECK(delivery_attempted IN (0, 1))`
    )
  }
  db.exec(`
    UPDATE room_messages SET delivery_attempted = 1
    WHERE delivery_attempted = 0 AND EXISTS (
      SELECT 1 FROM room_deliveries
      WHERE message_id = room_messages.id AND attempts > 0
    );
    CREATE TRIGGER IF NOT EXISTS room_delivery_attempt_locks_message
    AFTER UPDATE OF attempts ON room_deliveries
    WHEN OLD.attempts = 0 AND NEW.attempts > 0
    BEGIN
      UPDATE room_messages SET delivery_attempted = 1 WHERE id = NEW.message_id;
    END;
  `)
}
