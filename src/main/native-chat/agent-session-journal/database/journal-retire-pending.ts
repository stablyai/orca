import type Database from '../../../sqlite/sync-database'

// IF NOT EXISTS keeps old trigger bodies: rename a changed trigger and DROP the old name.
const PENDING_OBJECTS = [
  'journal_retire_pending',
  'journal_retire_pending_head_insert',
  'journal_retire_pending_head_epoch',
  'journal_retire_pending_item_epoch'
]

/**
 * Chats that may hold rows of an epoch other than their head's. The retired-epoch sweep reads only
 * these, so an idle store costs one empty read per pass instead of a visit to every chat. Triggers
 * catch every head epoch change and every item written beside a ready head (a fork stage, which an
 * abort or crash can strand), so writes from released builds are tracked too. Imports are covered
 * by the head write that makes them ready. Created without a user_version change: released builds
 * never read it. The caller passes its transaction runner: importing it here would close a cycle.
 */
export function ensureJournalRetirePending(
  db: Database.Database,
  inTransaction: (run: () => void) => void
): void {
  const present = db
    .prepare(
      `SELECT count(*) AS present FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))`
    )
    .get(JSON.stringify(PENDING_OBJECTS))
  if (Number(present?.present) === PENDING_OBJECTS.length) {
    return
  }
  // Anything missing means epoch changes may have gone unseen, so every ready head is re-enqueued.
  inTransaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS journal_retire_pending (
        session_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS journal_retire_pending_head_insert AFTER INSERT ON journal_chat_state
      WHEN NEW.epoch IS NOT NULL
      BEGIN
        INSERT INTO journal_retire_pending(session_id,generation) VALUES(NEW.session_id,1)
        ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS journal_retire_pending_head_epoch
      AFTER UPDATE OF epoch ON journal_chat_state
      WHEN NEW.epoch IS NOT NULL AND NEW.epoch IS NOT OLD.epoch
      BEGIN
        INSERT INTO journal_retire_pending(session_id,generation) VALUES(NEW.session_id,1)
        ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
      CREATE TRIGGER IF NOT EXISTS journal_retire_pending_item_epoch AFTER INSERT ON journal_items
      WHEN EXISTS (SELECT 1 FROM journal_chat_state
        WHERE session_id=NEW.session_id AND epoch IS NOT NULL AND epoch IS NOT NEW.epoch)
      BEGIN
        INSERT INTO journal_retire_pending(session_id,generation) VALUES(NEW.session_id,1)
        ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
      END;
      INSERT INTO journal_retire_pending(session_id,generation)
        SELECT session_id,1 FROM journal_chat_state WHERE epoch IS NOT NULL
        ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;`)
  )
}

/** A chat enqueued again since its pass began keeps its entry for the next pass. */
export function settleJournalRetirePending(
  db: Database.Database,
  sessionId: string,
  generation: number
): void {
  db.prepare('DELETE FROM journal_retire_pending WHERE session_id=? AND generation=?').run(
    sessionId,
    generation
  )
}
