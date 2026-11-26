// Each chat's ended-turn count, kept by triggers in every journal write's own transaction, so reading
// it is one row however long the chat is. Added without a user_version change: an older build opens
// the journal, and the triggers keep counting its writes too. The journal SQL worker runs this.

export const JOURNAL_ENDED_TURN_COUNTS = 'journal_ended_turn_counts'

// An ended turn's marker row: a turn several rows mark (its turn row and a legacy status of it)
// counts once, and clears and the running turn not at all.
const ended = (row: 'NEW' | 'OLD' | 'item') =>
  `(${row}.hidden=0 AND ${row}.turn_marker=1 AND ${row}.context_clear=0
    AND ${row}.lifecycle_state IS NOT 'running' AND ${row}.turn_id IS NOT NULL)`

const sameTurn = `(NEW.session_id=OLD.session_id AND NEW.epoch=OLD.epoch AND NEW.turn_id=OLD.turn_id)`

const add = `
  INSERT INTO ${JOURNAL_ENDED_TURN_COUNTS}(session_id,epoch,count)
    SELECT NEW.session_id,NEW.epoch,1 WHERE NOT EXISTS(SELECT 1 FROM journal_ended_turn_rows
      WHERE session_id=NEW.session_id AND epoch=NEW.epoch AND turn_id=NEW.turn_id)
    ON CONFLICT(session_id,epoch) DO UPDATE SET count=count+1;
  INSERT INTO journal_ended_turn_rows(session_id,epoch,turn_id,rows)
    VALUES(NEW.session_id,NEW.epoch,NEW.turn_id,1)
    ON CONFLICT(session_id,epoch,turn_id) DO UPDATE SET rows=rows+1;`

const remove = `
  UPDATE journal_ended_turn_rows SET rows=rows-1
    WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND turn_id=OLD.turn_id;
  UPDATE ${JOURNAL_ENDED_TURN_COUNTS} SET count=count-1
    WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND EXISTS(SELECT 1 FROM journal_ended_turn_rows
      WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND turn_id=OLD.turn_id AND rows<=0);
  DELETE FROM journal_ended_turn_rows
    WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND turn_id=OLD.turn_id AND rows<=0;
  DELETE FROM ${JOURNAL_ENDED_TURN_COUNTS}
    WHERE session_id=OLD.session_id AND epoch=OLD.epoch AND count<=0;`

const MARKER_COLUMNS = 'session_id,epoch,hidden,turn_marker,context_clear,lifecycle_state,turn_id'

/** Creates the count tables and triggers, counting the rows the journal already holds only while the
 *  triggers are absent. Run under the write lock: another process opening the journal at the same
 *  moment finds them made and changes nothing. */
export const JOURNAL_ENDED_TURN_COUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_ended_turn_rows (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  rows INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, turn_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ${JOURNAL_ENDED_TURN_COUNTS} (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch)
) WITHOUT ROWID;
INSERT INTO journal_ended_turn_rows(session_id,epoch,turn_id,rows)
  SELECT session_id,epoch,turn_id,COUNT(*) FROM journal_items item
  WHERE ${ended('item')} AND NOT EXISTS(SELECT 1 FROM sqlite_schema
    WHERE type='trigger' AND name='journal_ended_turns_insert')
  GROUP BY session_id,epoch,turn_id;
INSERT INTO ${JOURNAL_ENDED_TURN_COUNTS}(session_id,epoch,count)
  SELECT session_id,epoch,COUNT(*) FROM journal_ended_turn_rows WHERE NOT EXISTS(SELECT 1
    FROM sqlite_schema WHERE type='trigger' AND name='journal_ended_turns_insert')
  GROUP BY session_id,epoch;
CREATE TRIGGER IF NOT EXISTS journal_ended_turns_insert AFTER INSERT ON journal_items
  WHEN ${ended('NEW')} BEGIN ${add} END;
CREATE TRIGGER IF NOT EXISTS journal_ended_turns_delete AFTER DELETE ON journal_items
  WHEN ${ended('OLD')} BEGIN ${remove} END;
CREATE TRIGGER IF NOT EXISTS journal_ended_turns_update_old AFTER UPDATE OF ${MARKER_COLUMNS} ON journal_items
  WHEN ${ended('OLD')} AND NOT (${ended('NEW')} AND ${sameTurn}) BEGIN ${remove} END;
CREATE TRIGGER IF NOT EXISTS journal_ended_turns_update_new AFTER UPDATE OF ${MARKER_COLUMNS} ON journal_items
  WHEN ${ended('NEW')} AND NOT (${ended('OLD')} AND ${sameTurn}) BEGIN ${add} END;
`
