import type Database from '../../../sqlite/sync-database'

/**
 * Chats that may hold rows of an epoch other than their head's. The retired-epoch sweep reads only
 * these, so an idle store costs one empty read per pass instead of a visit to every chat. Triggers
 * catch every head epoch change, including writes from released builds; fork stages and imports
 * enqueue themselves because they write rows under an epoch the head doesn't name yet.
 * Created without a user_version change: released builds never read it, and their writes still
 * fire the triggers.
 */
export function ensureJournalRetirePending(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_retire_pending'`)
    .get()
  if (exists) {
    return
  }
  db.exec(`CREATE TABLE journal_retire_pending (
      session_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TRIGGER journal_retire_pending_head_insert AFTER INSERT ON journal_chat_state
    WHEN NEW.epoch IS NOT NULL
    BEGIN
      INSERT INTO journal_retire_pending(session_id,generation) VALUES(NEW.session_id,1)
      ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
    END;
    CREATE TRIGGER journal_retire_pending_head_epoch AFTER UPDATE OF epoch ON journal_chat_state
    WHEN NEW.epoch IS NOT NULL AND NEW.epoch IS NOT OLD.epoch
    BEGIN
      INSERT INTO journal_retire_pending(session_id,generation) VALUES(NEW.session_id,1)
      ON CONFLICT(session_id) DO UPDATE SET generation=generation+1;
    END;
    INSERT INTO journal_retire_pending(session_id,generation)
      SELECT session_id,1 FROM journal_chat_state WHERE epoch IS NOT NULL;`)
}

/** For writers about to store rows under an epoch the chat's head doesn't name yet. */
export function enqueueJournalRetirePending(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO journal_retire_pending(session_id,generation) VALUES(?,1)
    ON CONFLICT(session_id) DO UPDATE SET generation=generation+1`).run(sessionId)
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
