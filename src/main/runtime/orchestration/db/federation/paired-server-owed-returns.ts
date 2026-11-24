// The reverse conversations that owe a paired server replies now. A return page, the pull loop's
// reason to run and the servers it runs for read only this list, so their cost follows what is owed:
// never a pairing's history of answered conversations, nor another server's backlog.
import type { OrchestrationDb } from '../orchestration-db'
import { REVERSED_CONVERSATION_SQL } from './paired-server-asks-store'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

// The conversation `id` names owes its server while any reply there waits unacknowledged: one seek
// on the pending index, then it is listed under its pairing, once.
const OWE_CONVERSATION_SQL = (id: string) => `INSERT OR IGNORE INTO paired_server_owed_returns
    (conversation_id, environment_id, peer_fingerprint)
  SELECT c.conversation_id, c.environment_id, c.peer_fingerprint FROM peer_mail_conversations c
  WHERE c.conversation_id = ${id} AND c.role = 'peer' AND c.environment_id IS NOT NULL
    AND ${REVERSED_CONVERSATION_SQL}
    AND EXISTS (SELECT 1 FROM federation_relay_items i
      WHERE i.dispatch_id = c.conversation_id AND i.direction = 'to_home' AND i.acked_at IS NULL);`
// ...and stops owing once nothing there waits.
const SETTLE_CONVERSATION_SQL = (id: string) => `DELETE FROM paired_server_owed_returns
  WHERE conversation_id = ${id} AND NOT EXISTS (SELECT 1 FROM federation_relay_items i
    WHERE i.dispatch_id = ${id} AND i.direction = 'to_home' AND i.acked_at IS NULL);`

const OWED_RETURNS_SCHEMA_SQL = `
-- The reverse conversations that owe their server anything now, by pairing and in id order: a
-- return page, the pull loop's reason to run and the servers it runs for read only these, so
-- their cost follows what is owed, never a pairing's history or another server's backlog. The
-- relay's own writes keep it, whichever path queues, acknowledges, retires or resets a row.
CREATE TABLE IF NOT EXISTS paired_server_owed_returns (
  conversation_id        TEXT PRIMARY KEY,
  environment_id         TEXT NOT NULL,
  peer_fingerprint       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paired_server_owed_returns_route
  ON paired_server_owed_returns(environment_id, peer_fingerprint, conversation_id);
CREATE TRIGGER IF NOT EXISTS trg_paired_server_owed_on_queue
AFTER INSERT ON federation_relay_items
WHEN NEW.direction = 'to_home' AND NEW.acked_at IS NULL
BEGIN
  ${OWE_CONVERSATION_SQL('NEW.dispatch_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_paired_server_owed_on_ack
AFTER UPDATE OF acked_at ON federation_relay_items
WHEN NEW.direction = 'to_home'
BEGIN
  ${OWE_CONVERSATION_SQL('NEW.dispatch_id')}
  ${SETTLE_CONVERSATION_SQL('NEW.dispatch_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_paired_server_owed_on_delete
AFTER DELETE ON federation_relay_items
WHEN OLD.direction = 'to_home'
BEGIN
  ${SETTLE_CONVERSATION_SQL('OLD.dispatch_id')}
END;
`

/** Keeps the owed list (after the relay and conversation tables exist). A database made before it
 *  existed lists what it owes as it gains the list, in the same write, so none is ever missed. */
export function ensurePairedServerOwedReturns(db: OrchestrationDb['db']): void {
  const listed =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paired_server_owed_returns'"
      )
      .get() !== undefined
  if (listed) {
    db.exec(OWED_RETURNS_SCHEMA_SQL)
    return
  }
  runLifecycleWriteTransaction(db, 'paired_server_owed_returns', () => {
    db.exec(OWED_RETURNS_SCHEMA_SQL)
    db.exec(`INSERT OR IGNORE INTO paired_server_owed_returns
        (conversation_id, environment_id, peer_fingerprint)
      SELECT DISTINCT c.conversation_id, c.environment_id, c.peer_fingerprint
      FROM federation_relay_items i
      JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
      WHERE i.direction = 'to_home' AND i.acked_at IS NULL
        AND c.role = 'peer' AND c.environment_id IS NOT NULL AND ${REVERSED_CONVERSATION_SQL}`)
  })
}
