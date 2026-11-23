// The ask waiting on each item's owner, kept beside the items so an open reads only the events since it.
// Writes never touch it, so it costs them nothing; a side table, not a migration step, so older builds keep
// writing the file, and their events are checked like any other.
import { isTransientSqliteContention } from '../sqlite/sqlite-read-failure'
import type SyncDatabase from '../sqlite/sync-database'
import { botItemWaitingAsk } from '../../shared/bots/bot-item-question-answers'
import { botItemQuestionShape } from '../../shared/bots/bot-item-ask'
import { parseBotItemEventId, type BotItemActor } from '../../shared/bots/bot-items'
import { eventRecordOf, eventViewOf, optionalInteger } from './bot-items-rows'

/** The pairing rules a kept ask was worked out by; bump it with any change to what
 *  `botItemQuestionPairing` pairs, so asks kept by other rules (an upgrade or a downgrade) are worked out
 *  again rather than trusted. */
export const WAITING_ASK_RULES = 1

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
      at INTEGER NOT NULL,
      rules INTEGER NOT NULL
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

/** Keeps a pairing only while it read the item's newest event: one a write landed after stays unkept. */
function keepWaitingAsk(db: SyncDatabase, uid: string, paired: PairedWaitingAsk): void {
  db.prepare(
    `INSERT INTO item_waiting_asks (item_uid, ask, at, rules)
       SELECT ?, ?, ?, ? WHERE (SELECT last_event_id FROM items WHERE uid = ?) = ?
     ON CONFLICT(item_uid) DO UPDATE SET ask = excluded.ask, at = excluded.at, rules = excluded.rules`
  ).run(uid, paired.ask ?? 0, paired.at, WAITING_ASK_RULES, uid, paired.at)
}

let keepFailureTold = false

/** Outside any write and never waiting on another writer; a keep that fails (busy, a full disk) leaves the
 *  last kept ask, and a later open checks or pairs again. */
function quietly(db: SyncDatabase, keep: () => void): void {
  const timeout = Number(db.pragma('busy_timeout', { simple: true }) ?? 0)
  db.pragma('busy_timeout = 0')
  try {
    keep()
  } catch (error) {
    // Another writer is routine. Anything else is told once per run: a file the disk won't let us write
    // fails every keep, and each open still reads right.
    if (!isTransientSqliteContention(error) && !keepFailureTold) {
      keepFailureTold = true
      console.warn('[bots] items: keeping a waiting ask failed', error)
    }
  } finally {
    db.pragma(`busy_timeout = ${timeout}`)
  }
}

/** Events after a kept ask that an open checks before pairing every event again. Past it the open pairs
 *  them all and keeps the result, so the next open's check is short again. */
const CHECKED_EVENTS = 64

/** The kept ask while no event since it can change it, else paired from all the item's events and kept for
 *  the next open when `store` (outside any write). */
export function waitingAskOf(
  db: SyncDatabase,
  uid: string,
  keeps: boolean,
  store: boolean
): number | null {
  const kept = keeps
    ? db
        .prepare('SELECT ask, at FROM item_waiting_asks WHERE item_uid = ? AND rules = ?')
        .get(uid, WAITING_ASK_RULES)
    : undefined
  if (kept) {
    const ask = optionalInteger(kept, 'ask') ?? 0
    const since = db
      .prepare('SELECT * FROM item_events WHERE item_uid = ? AND id > ? ORDER BY id LIMIT ?')
      .all(uid, optionalInteger(kept, 'at') ?? 0, CHECKED_EVENTS + 1)
      .map(eventRecordOf)
    const changes = new Set(
      since.map((event) => waitingAskChange(event.kind, event.actor, event.data))
    )
    if (
      since.length <= CHECKED_EVENTS &&
      !changes.has('asks') &&
      (ask === 0 || !changes.has('answers'))
    ) {
      return ask === 0 ? null : ask
    }
  }
  const paired = pairWaitingAsk(db, uid)
  if (keeps && store) {
    quietly(db, () => keepWaitingAsk(db, uid, paired))
  }
  return paired.ask
}
