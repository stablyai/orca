// No user_version change: older builds never read the table, and its triggers drop a tail
// whenever any build rewrites or removes the row, so a stale tail never reattaches.
export const JOURNAL_TEXT_TAIL_SCHEMA = `
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
