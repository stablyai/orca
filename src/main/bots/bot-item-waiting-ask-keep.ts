// The ask waiting on each item's owner, kept beside the items so an open reads none of its history. A side
// table, not a migration step, so older builds keep writing the file; their events leave a kept ask stale.
import type SyncDatabase from '../sqlite/sync-database'
import { botItemWaitingAsk } from '../../shared/bots/bot-item-question-answers'
import { parseBotItemEventId } from '../../shared/bots/bot-items'
import { eventRecordOf, eventViewOf, optionalInteger } from './bot-items-rows'

/** An ask (0: none) as pairing the item's events up to `at` found it. */
export type PairedWaitingAsk = { ask: number | null; at: number }

/** Only comments and moves pair asks with answers. */
export function pairsWaitingAsks(kind: string): boolean {
  return kind === 'commented' || kind === 'status'
}

/** Makes the table on a file this build may write; false when the disk refuses. */
export function ensureKeptWaitingAsks(db: SyncDatabase): boolean {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS item_waiting_asks (
      item_uid TEXT PRIMARY KEY,
      ask INTEGER NOT NULL,
      at INTEGER NOT NULL
    ) WITHOUT ROWID`)
    return true
  } catch (error) {
    console.warn('[bots] items: keeping waiting asks is off for this file', error)
    return false
  }
}

export function hasKeptWaitingAsks(db: SyncDatabase): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_waiting_asks'")
      .get()
  )
}

/** The item's waiting ask from all its events, as clients pair them, while it is open. */
export function pairWaitingAsk(db: SyncDatabase, uid: string): PairedWaitingAsk {
  const records = db
    .prepare('SELECT * FROM item_events WHERE item_uid = ? ORDER BY id')
    .all(uid)
    .map(eventRecordOf)
  // Any open status pairs alike; readers drop the ask once the item closes.
  const ask = botItemWaitingAsk({ status: 'working' }, records.map(eventViewOf))
  return { ask: ask ? parseBotItemEventId(ask.askId) : null, at: records.at(-1)?.id ?? 0 }
}

/** The kept ask while it paired the item's newest event; undefined when none holds. */
export function keptWaitingAsk(db: SyncDatabase, uid: string): number | null | undefined {
  const row = db
    .prepare(
      `SELECT kept.ask FROM item_waiting_asks kept JOIN items ON items.uid = kept.item_uid
        WHERE kept.item_uid = ? AND kept.at = items.last_event_id`
    )
    .get(uid)
  const ask = row ? optionalInteger(row, 'ask') : null
  return ask === null ? undefined : ask === 0 ? null : ask
}

/** Keeps a pairing only while it read the item's newest event: one a write landed after stays unkept. */
export function keepWaitingAsk(db: SyncDatabase, uid: string, paired: PairedWaitingAsk): void {
  db.prepare(
    `INSERT INTO item_waiting_asks (item_uid, ask, at)
       SELECT ?, ?, ? WHERE (SELECT last_event_id FROM items WHERE uid = ?) = ?
     ON CONFLICT(item_uid) DO UPDATE SET ask = excluded.ask, at = excluded.at`
  ).run(uid, paired.ask ?? 0, paired.at, uid, paired.at)
}

/** An event that pairs nothing leaves a holding ask holding; call before the item takes event `id`. */
export function carryWaitingAsk(db: SyncDatabase, uid: string, id: number): void {
  db.prepare(
    `UPDATE item_waiting_asks SET at = ?
      WHERE item_uid = ? AND at = (SELECT last_event_id FROM items WHERE uid = ?)`
  ).run(id, uid, uid)
}
