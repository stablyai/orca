import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'

export const MUTATION_RECEIPT_MAX_ROWS = 10_000
const MUTATION_RECEIPT_MAX_AGE_DAYS = 30
const MUTATION_RECEIPT_PRUNE_BATCH_SIZE = 64

export function migrateMutationReceiptCapacity(db: Database.Database): void {
  // Why: database triggers keep the count exact for concurrent connections and older binaries.
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

function receiptCount(db: Database.Database): number {
  const row = db
    .prepare('SELECT receipt_count FROM mutation_receipt_ledger WHERE singleton = 1')
    .get() as { receipt_count: number } | undefined
  if (!row) {
    throw new Error('Mutation receipt ledger metadata is missing.')
  }
  return row.receipt_count
}

export function ensureMutationReceiptCapacity(db: Database.Database): void {
  db.prepare(
    `DELETE FROM mutation_receipts
     WHERE state = 'completed'
       AND updated_at < datetime('now', ?)`
  ).run(`-${MUTATION_RECEIPT_MAX_AGE_DAYS} days`)

  const count = receiptCount(db)
  if (count >= MUTATION_RECEIPT_MAX_ROWS) {
    db.prepare(
      `DELETE FROM mutation_receipts
       WHERE rowid IN (
         SELECT rowid FROM mutation_receipts
         WHERE state = 'completed'
         ORDER BY updated_at ASC, rowid ASC
         LIMIT ?
       )`
    ).run(count - MUTATION_RECEIPT_MAX_ROWS + MUTATION_RECEIPT_PRUNE_BATCH_SIZE)
  }

  if (receiptCount(db) >= MUTATION_RECEIPT_MAX_ROWS) {
    throw new OrchestrationError(
      'mutation_ledger_full',
      'The durable mutation ledger is full of unresolved operations. Resolve or inspect them before starting another mutation.'
    )
  }
}
