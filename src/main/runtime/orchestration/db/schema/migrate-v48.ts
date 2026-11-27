import type { OrchestrationDb } from '../orchestration-db'
import { BOT_REQUEST_SCHEMA_SQL } from '../bot-requests/bot-request-store'

/** What a Dispatch was started for (bot items), Dispatches indexed by their creator, and bot mail
 *  records keyed by send. Each part is skipped when already present. */
export function migrateV48(this: OrchestrationDb, current: number): void {
  if (current >= 48) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'origin_ref')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN origin_ref TEXT')
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_contexts_origin
      ON dispatch_contexts(origin_ref) WHERE origin_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_creator_orca_session_id
      ON dispatch_contexts(creator_orca_session_id) WHERE creator_orca_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_creator_pane_key
      ON dispatch_contexts(creator_pane_key) WHERE creator_pane_key IS NOT NULL;
  `)
  allowStatusBotRequests(this)
  if (!this.hasColumn('bot_requests', 'send_key')) {
    this.db.exec('ALTER TABLE bot_requests ADD COLUMN send_key TEXT')
  }
  // Early bot mail kept one handoff per bot per request; the send key replaced that.
  this.db.exec(`
    DROP INDEX IF EXISTS idx_bot_requests_one_handoff;
    DROP INDEX IF EXISTS idx_bot_requests_root;
    DROP TABLE IF EXISTS bot_request_roots;
    CREATE INDEX IF NOT EXISTS idx_bot_requests_send ON bot_requests(send_key);
  `)
}

/** Early bot_requests tables refuse the status purpose; rebuild once, keeping every row. */
function allowStatusBotRequests(db: OrchestrationDb): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sqlite_master's sql column is TEXT; the adapter exposes unknown.
  const table = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bot_requests'")
    .get() as { sql: string } | undefined
  if (!table || table.sql.includes("'status'")) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: table_info rows carry a TEXT name.
  const live = db.db.prepare('PRAGMA table_info(bot_requests)').all() as { name: string }[]
  const columns = live.map(({ name }) => name).join(', ')
  db.db.exec(`
    ALTER TABLE bot_requests RENAME TO bot_requests_before_status;
    DROP INDEX IF EXISTS idx_bot_requests_one_handoff;
    ${BOT_REQUEST_SCHEMA_SQL}
    INSERT INTO bot_requests (${columns}) SELECT ${columns} FROM bot_requests_before_status;
    DROP TABLE bot_requests_before_status;
  `)
}
