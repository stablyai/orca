import type { OrchestrationDb } from '../orchestration-db'

export function migrateV41(this: OrchestrationDb): void {
  if (this.hasColumn('deliveries', 'status')) {
    this.db.exec(`
      CREATE TABLE deliveries_v41 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        mailbox_handle TEXT NOT NULL DEFAULT '',
        consumer_generation INTEGER NOT NULL,
        message_ids TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_at TEXT,
        fenced INTEGER NOT NULL DEFAULT 0 CHECK(fenced IN (0, 1))
      );
      INSERT INTO deliveries_v41
        (id, run_id, mailbox_handle, consumer_generation, message_ids, created_at, acknowledged_at, fenced)
      SELECT id, run_id, mailbox_handle, consumer_generation, message_ids, created_at,
        acknowledged_at,
        CASE WHEN status = 'fenced' THEN 1 ELSE 0 END
      FROM deliveries ORDER BY rowid;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v41 RENAME TO deliveries;
    `)
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deliveries_run_created ON deliveries(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_unacknowledged_mailbox
      ON deliveries(mailbox_handle) WHERE acknowledged_at IS NULL AND fenced = 0;
    CREATE VIEW IF NOT EXISTS outstanding_deliveries AS
      SELECT * FROM deliveries
      WHERE acknowledged_at IS NULL AND fenced = 0
        AND EXISTS (
          SELECT 1 FROM json_each(deliveries.message_ids) AS member
          JOIN messages ON messages.id = member.value WHERE messages.read = 0
        );
    CREATE TRIGGER IF NOT EXISTS trg_deliveries_one_outstanding
      AFTER INSERT ON deliveries
      WHEN NEW.mailbox_handle != '' AND EXISTS (
        SELECT 1 FROM outstanding_deliveries WHERE mailbox_handle = NEW.mailbox_handle LIMIT 1 OFFSET 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mailbox already has an outstanding delivery');
      END;
  `)
}
