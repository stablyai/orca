// The ask waiting on each item's owner, kept beside the items so an open reads none of its history. A side
// table, not a migration step, so older builds keep writing the file; their events leave a kept ask stale.
import type SyncDatabase from '../sqlite/sync-database'
import { botItemWaitingAsk } from '../../shared/bots/bot-item-question-answers'
import { botItemQuestionShape } from '../../shared/bots/bot-item-ask'
import { parseBotItemEventId, type BotItemActor } from '../../shared/bots/bot-items'
import { eventRecordOf, eventViewOf, optionalInteger } from './bot-items-rows'

/** An ask (0: none) as pairing the item's events up to `at` found it. */
export type PairedWaitingAsk = { ask: number | null; at: number }

/** What one event can do to a kept ask, as pairing reads it: a question by anyone but the owner can make
 *  one wait; an owner comment, an answer's move or a move off Needs you can only answer or end one, so a
 *  kept "none" still holds after it; anything else (a bot comment that asks nothing, a move onto Needs you
 *  that answers nothing) pairs nothing. */
export function waitingAskChange(
  kind: string,
  actor: BotItemActor,
  data: Record<string, unknown>
): 'asks' | 'answers' | null {
  if (kind === 'commented') {
    if (actor.kind === 'owner') {
      return 'answers'
    }
    return botItemQuestionShape(data).decisions.length > 0 ? 'asks' : null
  }
  if (kind === 'status') {
    return data.to === 'needs_you' && data.cause !== 'answer' ? null : 'answers'
  }
  return null
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
function keepWaitingAsk(db: SyncDatabase, uid: string, paired: PairedWaitingAsk): void {
  db.prepare(
    `INSERT INTO item_waiting_asks (item_uid, ask, at)
       SELECT ?, ?, ? WHERE (SELECT last_event_id FROM items WHERE uid = ?) = ?
     ON CONFLICT(item_uid) DO UPDATE SET ask = excluded.ask, at = excluded.at`
  ).run(uid, paired.ask ?? 0, paired.at, uid, paired.at)
}

/** What one write did to an item: its newest event before it and after it, and the most any of its events
 *  can change a kept ask. */
export type TouchedItem = { before: number; last: number; change: 'asks' | 'answers' | null }

/** The item as a write left it once it added event `id`; `before` counts only for its first event. */
export function touchedBy(
  item: TouchedItem | undefined,
  before: number,
  id: number,
  change: TouchedItem['change']
): TouchedItem {
  const was = item?.change ?? null
  return {
    before: item?.before ?? before,
    last: id,
    change: was === 'asks' || change === 'asks' ? 'asks' : (was ?? change)
  }
}

export function lastEventOf(db: SyncDatabase, uid: string): number {
  const row = db.prepare('SELECT last_event_id FROM items WHERE uid = ?').get(uid)
  return row ? (optionalInteger(row, 'last_event_id') ?? 0) : 0
}

let keepFailureTold = false

/** Outside any transaction and never waiting on another writer; a keep that fails (busy, a full disk)
 *  leaves the kept ask stale, so a later open pairs the events again. */
function quietly(db: SyncDatabase, keep: () => void): void {
  const timeout = Number(db.pragma('busy_timeout', { simple: true }) ?? 0)
  db.pragma('busy_timeout = 0')
  try {
    keep()
  } catch (error) {
    // Once per run: a file the disk won't let us write fails every keep, and each open still reads right.
    if (!keepFailureTold) {
      keepFailureTold = true
      console.warn('[bots] items: keeping a waiting ask failed', error)
    }
  } finally {
    db.pragma(`busy_timeout = ${timeout}`)
  }
}

/** After a write, in one transaction of constant-time updates: carry each kept ask that held before it to
 *  the item's newest event when the write can't have changed it. Any other kept ask goes stale and the next
 *  open pairs the events once. */
export function keepAfterWrite(db: SyncDatabase, touched: ReadonlyMap<string, TouchedItem>): void {
  const carried = [...touched].filter(([, item]) => item.change !== 'asks')
  if (carried.length === 0) {
    return
  }
  quietly(db, () => {
    // Outside the try: a BEGIN that fails leaves no transaction of ours to roll back.
    db.exec('BEGIN IMMEDIATE')
    try {
      const carry = db.prepare(
        `UPDATE item_waiting_asks SET at = ?
          WHERE item_uid = ? AND at = ? AND (? OR ask = 0)
            AND (SELECT last_event_id FROM items WHERE uid = ?) = ?`
      )
      for (const [uid, item] of carried) {
        carry.run(item.last, uid, item.before, Number(item.change === null), uid, item.last)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

/** The kept ask while it holds, else paired from all the item's events, and kept for the next open when
 *  `store` (outside any write). */
export function waitingAskOf(
  db: SyncDatabase,
  uid: string,
  keeps: boolean,
  store: boolean
): number | null {
  const kept = keeps ? keptWaitingAsk(db, uid) : undefined
  if (kept !== undefined) {
    return kept
  }
  const paired = pairWaitingAsk(db, uid)
  if (keeps && store) {
    quietly(db, () => keepWaitingAsk(db, uid, paired))
  }
  return paired.ask
}
