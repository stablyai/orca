// The bot items file: forward-only migrations by `user_version`, each one transaction, and its rows'
// shapes. A newer Orca's file opens read-only.
import type SyncDatabase from '../sqlite/sync-database'
import type {
  BotItemActor,
  BotItemChatKind,
  BotItemLinkKind,
  BotItemStatus
} from '../../shared/bots/bot-items'

/** Each step once, in order; exported so a test can build an older file. */
export const BOT_ITEMS_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE items (
    uid TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    owner_bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source TEXT NOT NULL,
    made_by TEXT,
    title TEXT NOT NULL,
    description TEXT,
    done_means TEXT,
    status TEXT NOT NULL CHECK(status IN ('planned','working','needs_you','done','canceled')),
    -- Needs you: the comment that asks the owner.
    question_event INTEGER,
    close_note TEXT,
    version INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX idx_items_owner_open ON items(owner_bot_id, status, last_activity_at DESC);

  CREATE TABLE item_links (
    item_uid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dispatch','pr','url','file')),
    ref TEXT NOT NULL,
    added_event INTEGER NOT NULL,
    PRIMARY KEY (item_uid, kind, ref)
  );
  CREATE INDEX idx_item_links_ref ON item_links(kind, ref);

  CREATE TABLE item_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_uid TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    data TEXT NOT NULL,
    -- A change the item's own chat didn't make mails that chat. owed: the mail is not in the
    -- orchestration DB yet; sent: it is.
    mail TEXT CHECK(mail IN ('owed','sent')),
    -- The first event of the write this one came in: one write mails each chat once.
    action INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_item_events_mail_owed ON item_events(action) WHERE mail = 'owed';
  CREATE INDEX idx_item_events_item ON item_events(item_uid, id);
  `,
  // The bot list's Needs you counts read only those items, and item views read who last wrote
  // besides the owner from the item row.
  `
  CREATE INDEX idx_items_needs_you ON items(owner_bot_id, last_activity_at) WHERE status = 'needs_you';
  ALTER TABLE items ADD COLUMN others_last_event_id INTEGER NOT NULL DEFAULT 0;
  UPDATE items SET others_last_event_id = COALESCE((SELECT MAX(id) FROM item_events
    WHERE item_uid = items.uid AND json_extract(actor, '$.kind') != 'owner'), 0);
  `,
  // The owner's snooze: hidden from its group until then, keeping its status. The Needs you counts read
  // it too, so their index covers it.
  `
  ALTER TABLE items ADD COLUMN snoozed_until INTEGER;
  DROP INDEX idx_items_needs_you;
  CREATE INDEX idx_items_needs_you ON items(owner_bot_id, last_activity_at, snoozed_until)
    WHERE status = 'needs_you';
  `,
  // Waiting, which keeps the status event saying what it waits on, and links to automations (waits).
  // SQLite changes a CHECK only by copying the table.
  `
  CREATE TABLE items_next (
    uid TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    owner_bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source TEXT NOT NULL,
    made_by TEXT,
    title TEXT NOT NULL,
    description TEXT,
    done_means TEXT,
    status TEXT NOT NULL
      CHECK(status IN ('planned','working','waiting','needs_you','done','canceled')),
    question_event INTEGER,
    close_note TEXT,
    version INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    others_last_event_id INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    -- Waiting: the status event whose note says what it waits on.
    wait_event INTEGER
  );
  INSERT INTO items_next (uid, number, owner_bot_id, chat_id, source, made_by, title, description,
    done_means, status, question_event, close_note, version, last_event_id, last_activity_at,
    created_at, updated_at, closed_at, others_last_event_id, snoozed_until)
  SELECT uid, number, owner_bot_id, chat_id, source, made_by, title, description, done_means, status,
    question_event, close_note, version, last_event_id, last_activity_at, created_at, updated_at,
    closed_at, others_last_event_id, snoozed_until FROM items;
  DROP TABLE items;
  ALTER TABLE items_next RENAME TO items;
  CREATE INDEX idx_items_owner_open ON items(owner_bot_id, status, last_activity_at DESC);
  CREATE INDEX idx_items_needs_you ON items(owner_bot_id, last_activity_at, snoozed_until)
    WHERE status = 'needs_you';

  CREATE TABLE item_links_next (
    item_uid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dispatch','pr','url','file','automation')),
    ref TEXT NOT NULL,
    added_event INTEGER NOT NULL,
    PRIMARY KEY (item_uid, kind, ref)
  );
  INSERT INTO item_links_next SELECT item_uid, kind, ref, added_event FROM item_links;
  DROP TABLE item_links;
  ALTER TABLE item_links_next RENAME TO item_links;
  CREATE INDEX idx_item_links_ref ON item_links(kind, ref);
  `,
  `
  -- The ask waiting on the owner (0: none), as the events up to waiting_ask_at pair it; it holds while
  -- that is still last_event_id.
  ALTER TABLE items ADD COLUMN waiting_ask INTEGER;
  ALTER TABLE items ADD COLUMN waiting_ask_at INTEGER;
  `
]

/** Runs the steps a file lacks; false when a newer Orca wrote it, so it must stay read-only. */
export function migrateBotItems(db: SyncDatabase): boolean {
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0)
  if (version > BOT_ITEMS_MIGRATIONS.length) {
    return false
  }
  for (let step = version; step < BOT_ITEMS_MIGRATIONS.length; step++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(BOT_ITEMS_MIGRATIONS[step]!)
      db.exec(`PRAGMA user_version = ${step + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return true
}

export type BotItemSource = { kind: BotItemChatKind; title: string | null }

export type BotItemMadeBy = { botId: string; chatId: string }

/** An item row as stored. */
export type BotItemRecord = {
  uid: string
  number: number
  ownerBotId: string
  chatId: string
  source: BotItemSource
  madeBy: BotItemMadeBy | null
  title: string
  description: string | null
  doneMeans: string | null
  status: BotItemStatus
  questionEvent: number | null
  /** Waiting: the status event that set it, whose note is what it waits on. */
  waitEvent: number | null
  closeNote: string | null
  /** The owner snoozed it until then; a new question, a close or the owner's own move clears it. */
  snoozedUntil: number | null
  version: number
  lastEventId: number
  lastActivityAt: number
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export type BotItemLinkRecord = {
  itemUid: string
  kind: BotItemLinkKind
  ref: string
  addedEvent: number
}

export type BotItemEventRecord = {
  id: number
  itemUid: string
  kind: string
  actor: BotItemActor
  data: Record<string, unknown>
  createdAt: number
}

/** One owed mail: what one write changed on one chat's items. Its id is its first event's. */
export type BotItemMail = {
  id: number
  ownerBotId: string
  chatId: string
  changes: { event: BotItemEventRecord; item: BotItemRecord }[]
}
