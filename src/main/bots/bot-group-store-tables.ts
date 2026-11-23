import type Database from '../sqlite/sync-database'
import type { BotGroup } from '../../shared/bots/bot-group'
import { SAVE_DROPPED } from './bot-group-record-keys'

// The group store's tables, and what keeps their records whole across builds.

/**
 * Fields an older build drops when it writes a record back, since its schema strips keys it
 * doesn't know: a rollback, then an edit, a new thread or a turn update, would lose the paired
 * roster, the remote answers and the image refs. The database keeps them, so the trigger runs in
 * whichever build writes. A build that knows a field clears it by writing an empty list.
 */
const KEPT_FIELDS = [
  ['bot_groups', 'remoteMembers'],
  ['bot_group_messages', 'images'],
  ['bot_group_messages', 'remoteAsks']
] as const

function keepFieldTrigger(table: string, field: string): string {
  const path = `'$.${field}'`
  return `CREATE TRIGGER IF NOT EXISTS ${table}_keep_${field} AFTER UPDATE OF record ON ${table}
    WHEN json_type(NEW.record, ${path}) IS NULL AND json_type(OLD.record, ${path}) IS NOT NULL
    BEGIN
      UPDATE ${table} SET record = json_set(record, ${path}, OLD.record -> ${path}) WHERE rowid = NEW.rowid;
    END;`
}

const OF_GROUP = 'SELECT id FROM bot_group_messages WHERE group_id = ?'

/** Deletes, by group id, the group and everything kept for it: messages, pending sends, operation
 *  and worker links. */
export const GROUP_DELETES = [
  `DELETE FROM bot_group_worker_operations WHERE operation_id IN
    (SELECT operation_id FROM bot_group_operations WHERE message_id IN (${OF_GROUP}))`,
  `DELETE FROM bot_group_operations WHERE message_id IN (${OF_GROUP})`,
  `DELETE FROM bot_group_remote_asks WHERE message_id IN (${OF_GROUP})`,
  'DELETE FROM bot_group_pending WHERE group_id = ?',
  'DELETE FROM bot_group_messages WHERE group_id = ?',
  'DELETE FROM bot_group_sidebar WHERE group_id = ?',
  'DELETE FROM bot_groups WHERE id = ?'
]

/** `put` stores no remote members as an empty list; it reads as none. */
export function withoutClearedRoster(group: BotGroup): BotGroup {
  if (group.remoteMembers?.length !== 0) {
    return group
  }
  const { remoteMembers: _cleared, ...rest } = group
  return rest
}

/**
 * Indexes the questions of posts added since the last pass: those from before this table existed,
 * and those a build that asks without indexing added since. The scan goes by sequence, which only
 * grows, so each startup reads only new posts. A damaged record is skipped, and the pass never
 * stops the store from opening. A trigger drops a post's rows when any build deletes the post;
 * rows left from before the trigger existed are dropped once, when it is created.
 */
function indexRemoteAsks(db: Database): boolean {
  db.exec('SAVEPOINT bot_group_remote_asks')
  try {
    const dropsRows = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'bot_group_messages_drop_remote_asks'"
      )
      .get()
    if (!dropsRows) {
      db.exec(`CREATE TRIGGER bot_group_messages_drop_remote_asks AFTER DELETE ON bot_group_messages
          BEGIN DELETE FROM bot_group_remote_asks WHERE message_id = OLD.id; END;
        DELETE FROM bot_group_remote_asks WHERE message_id NOT IN (SELECT id FROM bot_group_messages);`)
    }
    const scanned = db
      .prepare('SELECT sequence FROM bot_group_remote_asks_scanned WHERE id = 1')
      .get()
    db.prepare(
      `WITH m AS (
        SELECT id, CASE WHEN json_valid(record) THEN record ELSE '{}' END AS record
        FROM bot_group_messages
        -- Only a post that names a question is parsed, so a first pass over long history stays a text scan.
        WHERE sequence > ? AND instr(record, '"remoteAsks"') > 0)
      INSERT OR IGNORE INTO bot_group_remote_asks(request_id, message_id)
      SELECT json_extract(m.record, ask.fullkey || '.requestId'), m.id
      FROM m, json_each(m.record, '$.remoteAsks') ask
      WHERE json_type(m.record, ask.fullkey || '.requestId') = 'text'`
    ).run(Number(scanned?.sequence ?? 0))
    db.exec(`INSERT OR REPLACE INTO bot_group_remote_asks_scanned(id, sequence)
        SELECT 1, coalesce(max(sequence), 0) FROM bot_group_messages;
      RELEASE bot_group_remote_asks;`)
    return true
  } catch (error) {
    db.exec('ROLLBACK TO bot_group_remote_asks')
    db.exec('RELEASE bot_group_remote_asks')
    console.warn('[bot-groups] could not index remote questions', error)
    return false
  }
}

/** Whether older posts' questions are all indexed. */
export function createBotGroupTables(db: Database): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_groups (id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_group_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_group_operations (operation_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_group_pending (operation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_group_worker_operations (dispatch_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bot_group_worker_operation ON bot_group_worker_operations(operation_id);
    CREATE INDEX IF NOT EXISTS bot_group_messages_room ON bot_group_messages(group_id, sequence);
    -- Same expression as roomMessages, so a room page reads only its own thread's rows; any build's writes keep it current.
    CREATE INDEX IF NOT EXISTS bot_group_messages_thread
      ON bot_group_messages(group_id, coalesce(json_extract(record, '$.threadId'), ''), sequence);
    CREATE TABLE IF NOT EXISTS bot_group_sidebar (group_id TEXT PRIMARY KEY, sidebar_order INTEGER, latest TEXT);
    -- The post each remote question went with, so its answer's mail finds it without reading rooms.
    CREATE TABLE IF NOT EXISTS bot_group_remote_asks (request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bot_group_remote_asks_message ON bot_group_remote_asks(message_id);
    CREATE TABLE IF NOT EXISTS bot_group_remote_asks_scanned (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL);`)
  for (const trigger of [
    ...KEPT_FIELDS.map(([table, field]) => keepFieldTrigger(table, field)),
    ...SAVE_DROPPED
  ]) {
    db.exec(trigger)
  }
  return indexRemoteAsks(db)
}
