import type Database from '../../../../sqlite/sync-database'

export function migrateLegacyMutationReceiptCount(db: Database.Database): void {
  // Older binaries still require this count when accepting commands after a downgrade.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_receipts_completed_updated
      ON mutation_receipts(updated_at) WHERE state = 'completed';

    CREATE TABLE IF NOT EXISTS mutation_receipt_ledger (
      singleton     INTEGER PRIMARY KEY CHECK(singleton = 1),
      receipt_count INTEGER NOT NULL CHECK(receipt_count >= 0)
    );

    INSERT INTO mutation_receipt_ledger (singleton, receipt_count)
    SELECT 1, COUNT(*) FROM mutation_receipts
    -- SQLite needs a WHERE to disambiguate SELECT UPSERT syntax.
    WHERE true
    ON CONFLICT(singleton) DO UPDATE SET receipt_count = excluded.receipt_count;

    CREATE TRIGGER IF NOT EXISTS mutation_receipts_count_insert
    AFTER INSERT ON mutation_receipts
    BEGIN
      UPDATE mutation_receipt_ledger
      SET receipt_count = receipt_count + 1
      WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS mutation_receipts_count_delete
    AFTER DELETE ON mutation_receipts
    BEGIN
      UPDATE mutation_receipt_ledger
      SET receipt_count = receipt_count - 1
      WHERE singleton = 1;
    END;
  `)
}

// Why: the count triggers fire on every receipt insert, so a missing count table would refuse every command.
export function repairLegacyMutationReceiptCount(db: Database.Database): void {
  const ledger = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mutation_receipt_ledger'"
    )
    .get()
  if (ledger && db.prepare('SELECT 1 FROM mutation_receipt_ledger WHERE singleton = 1').get()) {
    return
  }
  try {
    migrateLegacyMutationReceiptCount(db)
  } catch (error) {
    console.warn('[orchestration] could not repair the legacy mutation receipt count', error)
  }
}
