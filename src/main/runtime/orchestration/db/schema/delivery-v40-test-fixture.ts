import type { OrchestrationDb } from '../orchestration-db'

// Older-version tests must seed the actual historical schema, not just lower user_version.
export function restoreV40DeliverySchema(db: OrchestrationDb['db']): void {
  const columns = db.pragma('table_info(deliveries)') as { name: string }[]
  if (!columns.some((column) => column.name === 'fenced')) {
    return
  }
  db.exec(`
    DROP TRIGGER IF EXISTS trg_deliveries_one_outstanding;
    DROP VIEW IF EXISTS outstanding_deliveries;
    CREATE TABLE deliveries_v40 (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, mailbox_handle TEXT NOT NULL DEFAULT '',
      consumer_generation INTEGER NOT NULL, message_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'outstanding' CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), acknowledged_at TEXT
    );
    INSERT INTO deliveries_v40
      SELECT id, run_id, mailbox_handle, consumer_generation, message_ids,
        CASE WHEN fenced = 1 THEN 'fenced'
             WHEN acknowledged_at IS NOT NULL THEN 'acknowledged' ELSE 'outstanding' END,
        created_at, acknowledged_at
      FROM deliveries ORDER BY rowid;
    DROP TABLE deliveries;
    ALTER TABLE deliveries_v40 RENAME TO deliveries;
    CREATE UNIQUE INDEX idx_deliveries_one_outstanding
      ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
    CREATE INDEX idx_deliveries_run_created ON deliveries(run_id, created_at);
  `)
}
