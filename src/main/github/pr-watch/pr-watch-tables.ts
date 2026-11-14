import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type Database from '../../sqlite/sync-database'
import { numberColumn, textColumn, textColumnValues } from './pr-watch-sqlite-columns'

/** Added without a user_version change, so an older build opens the journal and ignores them. */
export function ensurePRWatchTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS pr_chat_actions (
  chat_id         TEXT    NOT NULL,
  anchor_item_id  TEXT    NOT NULL,
  anchor_revision INTEGER NOT NULL,
  forge_host      TEXT    NOT NULL,
  owner           TEXT    NOT NULL,
  repo            TEXT    NOT NULL,
  number          INTEGER NOT NULL,
  kind            TEXT    NOT NULL,
  head_sha        TEXT,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, anchor_item_id, forge_host, owner, repo, number, kind)
);
CREATE INDEX IF NOT EXISTS pr_chat_actions_by_pr
  ON pr_chat_actions (forge_host, owner, repo, number);
CREATE TABLE IF NOT EXISTS pr_check_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key          TEXT    NOT NULL,
  head_sha        TEXT    NOT NULL,
  occurrence      INTEGER NOT NULL,
  verdict         TEXT    NOT NULL,
  completed_at    INTEGER NOT NULL,
  observed_at     INTEGER NOT NULL,
  is_current_head INTEGER NOT NULL,
  UNIQUE (pr_key, head_sha, occurrence)
);
CREATE TABLE IF NOT EXISTS pr_event_deliveries (
  chat_id  TEXT    NOT NULL,
  event_id INTEGER NOT NULL,
  state    TEXT    NOT NULL,
  item_id  TEXT,
  PRIMARY KEY (chat_id, event_id)
);
CREATE TABLE IF NOT EXISTS pr_pending_heads (
  pr_key        TEXT    NOT NULL,
  head_sha      TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  moved_at      INTEGER,
  expires_at    INTEGER,
  PRIMARY KEY (pr_key, head_sha)
);
CREATE TABLE IF NOT EXISTS pr_pending_actions (
  chat_id             TEXT    NOT NULL,
  anchor_item_id      TEXT    NOT NULL,
  anchor_revision     INTEGER NOT NULL,
  evidence_json       TEXT    NOT NULL,
  finished_at         INTEGER NOT NULL,
  resolve_deadline_at INTEGER NOT NULL,
  verify_deadline_at  INTEGER NOT NULL,
  next_attempt_at     INTEGER NOT NULL,
  attempts            INTEGER NOT NULL,
  PRIMARY KEY (chat_id, anchor_item_id)
);
CREATE INDEX IF NOT EXISTS pr_pending_actions_by_due ON pr_pending_actions (next_attempt_at);
CREATE TABLE IF NOT EXISTS pr_check_contexts (
  pr_key       TEXT    NOT NULL,
  head_sha     TEXT    NOT NULL,
  context      TEXT    NOT NULL,
  last_state   TEXT,
  last_run_id  TEXT,
  pending_seen INTEGER NOT NULL,
  PRIMARY KEY (pr_key, head_sha, context)
);
`)
}

export type PRChatActionKind = 'opened' | 'pushed'

export type PRChatAction = {
  chatId: string
  anchor: { itemId: string; revision: number }
  forgeHost: string
  owner: string
  repo: string
  number: number
  kind: PRChatActionKind
  headSha: string | null
  observedAt: number
}

export const PR_KEY_SQL = `forge_host || '/' || owner || '/' || repo || '#' || number`

function actionFromRow(row: SqliteRow): PRChatAction[] {
  const chatId = textColumn(row, 'chat_id')
  const itemId = textColumn(row, 'anchor_item_id')
  const forgeHost = textColumn(row, 'forge_host')
  const owner = textColumn(row, 'owner')
  const repo = textColumn(row, 'repo')
  const kind = textColumn(row, 'kind')
  const revision = numberColumn(row, 'anchor_revision')
  const number = numberColumn(row, 'number')
  const observedAt = numberColumn(row, 'observed_at')
  if (
    chatId === null ||
    itemId === null ||
    forgeHost === null ||
    owner === null ||
    repo === null ||
    (kind !== 'opened' && kind !== 'pushed') ||
    revision === null ||
    number === null ||
    observedAt === null
  ) {
    return []
  }
  return [
    {
      chatId,
      anchor: { itemId, revision },
      forgeHost,
      owner,
      repo,
      number,
      kind,
      headSha: textColumn(row, 'head_sha'),
      observedAt
    }
  ]
}

export function insertPRChatAction(db: Database.Database, action: PRChatAction): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO pr_chat_actions
        (chat_id, anchor_item_id, anchor_revision, forge_host, owner, repo, number, kind, head_sha, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      action.chatId,
      action.anchor.itemId,
      action.anchor.revision,
      action.forgeHost.toLowerCase(),
      action.owner.toLowerCase(),
      action.repo.toLowerCase(),
      action.number,
      action.kind,
      action.headSha,
      action.observedAt
    )
  return Number(result.changes) > 0
}

export function readPRChatActions(db: Database.Database, prKey?: string): PRChatAction[] {
  const rows =
    prKey === undefined
      ? db.prepare('SELECT * FROM pr_chat_actions ORDER BY observed_at').all()
      : db
          .prepare(`SELECT * FROM pr_chat_actions WHERE ${PR_KEY_SQL} = ? ORDER BY observed_at`)
          .all(prKey)
  return rows.flatMap(actionFromRow)
}

export function hasPRChatActionFrom(
  db: Database.Database,
  chatId: string,
  anchorItemId: string
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM pr_chat_actions WHERE chat_id = ? AND anchor_item_id = ? LIMIT 1')
      .get(chatId, anchorItemId) !== undefined
  )
}

export function readPRWatchChatIds(db: Database.Database): string[] {
  return textColumnValues(
    db
      .prepare(
        `SELECT chat_id FROM pr_chat_actions UNION SELECT chat_id FROM pr_event_deliveries
          UNION SELECT chat_id FROM pr_pending_actions`
      )
      .all(),
    'chat_id'
  )
}

/** A gone chat takes its actions and deliveries; events, heads and context memory no remaining
 *  chat owns go with them, so nothing survives its last owner. */
export function deletePRWatchChats(db: Database.Database, chatIds: readonly string[]): void {
  const actions = db.prepare('DELETE FROM pr_chat_actions WHERE chat_id = ?')
  const deliveries = db.prepare('DELETE FROM pr_event_deliveries WHERE chat_id = ?')
  const pending = db.prepare('DELETE FROM pr_pending_actions WHERE chat_id = ?')
  for (const chatId of chatIds) {
    actions.run(chatId)
    deliveries.run(chatId)
    pending.run(chatId)
  }
  db.exec(`
DELETE FROM pr_check_events WHERE id NOT IN (SELECT event_id FROM pr_event_deliveries);
DELETE FROM pr_pending_heads WHERE pr_key NOT IN (SELECT ${PR_KEY_SQL} FROM pr_chat_actions);
DELETE FROM pr_check_contexts WHERE pr_key NOT IN (SELECT ${PR_KEY_SQL} FROM pr_chat_actions);
`)
}

/** Deletes gone chats' saved state (and anything no remaining chat owns); returns the PRs still owned. */
export function sweepGonePRWatchChats(
  database: { db: Database.Database; transaction: <T>(run: (db: Database.Database) => T) => T },
  chatExists: (chatId: string) => boolean
): { gone: string[]; owned: Set<string> } {
  const gone = readPRWatchChatIds(database.db).filter((chatId) => !chatExists(chatId))
  database.transaction((db) => deletePRWatchChats(db, gone))
  const owned = new Set(readPRChatActions(database.db).map((action) => pullRequestKey(action)))
  return { gone, owned }
}
