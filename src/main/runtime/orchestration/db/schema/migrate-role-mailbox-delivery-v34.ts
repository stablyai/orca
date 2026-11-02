import type { OrchestrationDb } from '../orchestration-db'

export function migrateRoleMailboxDeliveryV34(this: OrchestrationDb, current: number): void {
  if (current >= 34) {
    return
  }

  const mailboxColumn = (
    this.db.pragma('table_info(deliveries)') as { name: string; notnull: number }[]
  ).find((column) => column.name === 'mailbox_handle')
  if (mailboxColumn?.notnull === 1) {
    this.db.exec(`
      DROP INDEX IF EXISTS idx_deliveries_one_outstanding;
      CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
      CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
        ON deliveries(run_id, created_at);
    `)
    return
  }

  const mailboxExpression = mailboxColumn
    ? "COALESCE(mailbox_handle, 'run:' || run_id)"
    : "'run:' || run_id"
  this.db.exec(`
    CREATE TABLE deliveries_new (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      mailbox_handle        TEXT NOT NULL DEFAULT '',
      consumer_generation   INTEGER NOT NULL,
      message_ids           TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'outstanding'
        CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at       TEXT
    );
    INSERT INTO deliveries_new (
      id, run_id, mailbox_handle, consumer_generation, message_ids,
      status, created_at, acknowledged_at
    )
    SELECT
      id, run_id, ${mailboxExpression}, consumer_generation, message_ids,
      status, created_at, acknowledged_at
    FROM deliveries;
    DROP TABLE deliveries;
    ALTER TABLE deliveries_new RENAME TO deliveries;

    CREATE UNIQUE INDEX idx_deliveries_one_outstanding
      ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
    CREATE INDEX idx_deliveries_run_created
      ON deliveries(run_id, created_at);
  `)
}
