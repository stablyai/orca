import type { OrchestrationDb } from '../orchestration-db'
import { WATERMARK_RECEIPT_SQL } from '../mutation-receipts/mutation-receipt-retention'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  if (!this.hasColumn('mutation_receipts', 'retain_from_ms')) {
    this.db.exec('ALTER TABLE mutation_receipts ADD COLUMN retain_from_ms INTEGER')
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_receipts_retain_from
      ON mutation_receipts(retain_from_ms) WHERE retain_from_ms IS NOT NULL;
    UPDATE mutation_receipts SET retain_from_ms = CAST(strftime('%s', created_at) AS INTEGER) * 1000
      WHERE retain_from_ms IS NULL AND ${WATERMARK_RECEIPT_SQL};
    CREATE TABLE IF NOT EXISTS mutation_receipt_retirement (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      retired_before_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO mutation_receipt_retirement VALUES (1, 0);
  `)
}
