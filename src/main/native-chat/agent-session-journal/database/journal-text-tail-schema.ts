import type Database from '../../../sqlite/sync-database'

// No user_version change: older builds never read the table, and its triggers drop a tail
// whenever any build rewrites or removes the row, so a stale tail never reattaches.
const JOURNAL_TEXT_TAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_text_tail (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- What is saved through this row, so the next save reads this row alone.
  saved_chars INTEGER NOT NULL,
  folded_chars INTEGER NOT NULL,
  saved_hash TEXT NOT NULL,
  skeleton TEXT NOT NULL,
  -- The item's turn, so a finished turn finds its own tails without visiting other turns'.
  turn_item_id TEXT,
  PRIMARY KEY(session_id, epoch, item_id, seq)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS journal_text_tail_rewritten AFTER UPDATE OF payload_json ON journal_items
BEGIN
  DELETE FROM journal_text_tail
  WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND item_id=OLD.item_id;
END;
CREATE TRIGGER IF NOT EXISTS journal_text_tail_removed AFTER DELETE ON journal_items
BEGIN
  DELETE FROM journal_text_tail
  WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND item_id=OLD.item_id;
END;`

// A table made by a pre-release build of this change lacks later columns; their defaults read as
// "nothing saved", so the next save rewrites the item whole and drops those rows.
const LATER_COLUMNS = [
  ['saved_chars', 'INTEGER NOT NULL DEFAULT 0'],
  ['folded_chars', 'INTEGER NOT NULL DEFAULT 0'],
  ['saved_hash', "TEXT NOT NULL DEFAULT ''"],
  ['skeleton', "TEXT NOT NULL DEFAULT ''"],
  ['turn_item_id', 'TEXT']
] as const

export function ensureJournalTextTailTable(db: Database.Database): void {
  db.exec(JOURNAL_TEXT_TAIL_SCHEMA)
  const present = new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info('journal_text_tail')`)
      .all()
      .map((row) => String(row.name))
  )
  for (const [name, type] of LATER_COLUMNS) {
    if (!present.has(name)) {
      db.exec(`ALTER TABLE journal_text_tail ADD COLUMN ${name} ${type}`)
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS journal_text_tail_turn
    ON journal_text_tail(session_id, epoch, turn_item_id, item_id) WHERE turn_item_id IS NOT NULL`)
}
