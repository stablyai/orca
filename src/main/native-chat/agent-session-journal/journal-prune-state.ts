import type Database from '../../sqlite/sync-database'
import type { JournalTransaction } from './journal-database'
import type { JournalPruneCandidate, JournalPruneCandidates } from './journal-prune-policy'

/** Bump (and drop the previous version's tables) to retire every saved frontier, candidate and
 *  refusal after a policy or parser change: `CREATE TABLE IF NOT EXISTS` never reshapes a table. */
const JOURNAL_PRUNE_TABLES_VERSION = 1
const PROGRESS = `journal_prune_progress_v${JOURNAL_PRUNE_TABLES_VERSION}`
const WORK = `journal_prune_work_v${JOURNAL_PRUNE_TABLES_VERSION}`

/** Every writable open, no `user_version` bump (see `ensureQueuedMessagesTable`): progress survives
 *  restarts, so a launch reads only rows appended since the last pass. */
export function ensureJournalPruneTables(db: Database.Database): boolean {
  try {
    // Changing temp_store later destroys callers' TEMP objects.
    const forcedMemory = db
      .prepare('PRAGMA compile_options')
      .all()
      .some((row) => Object.values(row).includes('TEMP_STORE=3'))
    if (forcedMemory) {
      throw new Error('SQLite forces in-memory temporary storage')
    }
    db.pragma('temp_store = FILE')
    if (Number(db.pragma('temp_store', { simple: true })) !== 1) {
      throw new Error('SQLite did not enable file-backed temporary storage')
    }
    db.pragma('temp.cache_size = -2048')
    db.exec(`CREATE TABLE IF NOT EXISTS ${PROGRESS} (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ${WORK} (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
) WITHOUT ROWID;
CREATE TEMP TABLE journal_prune_items (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, item_id TEXT NOT NULL,
  seq INTEGER NOT NULL, revision INTEGER NOT NULL, signature TEXT NOT NULL,
  removable INTEGER NOT NULL, saved_at REAL NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;`)
    return true
  } catch (error) {
    console.warn('[journal-maintenance] disabled:', error)
    return false
  }
}

export type JournalPruneEpoch = { sessionId: string; epoch: string }
export type JournalPruneCursor<T> = { after: T | null; through: T }

export function readJournalPruneBounds(db: Database.Database): {
  session: string | null
  progress: JournalPruneEpoch | null
} {
  const session = db
    .prepare('SELECT session_id FROM journal_sessions ORDER BY session_id DESC LIMIT 1')
    .get()
  const progress = db
    .prepare(`SELECT session_id, epoch FROM ${PROGRESS}
ORDER BY session_id DESC, epoch DESC LIMIT 1`)
    .get()
  return {
    session: typeof session?.session_id === 'string' ? session.session_id : null,
    progress:
      typeof progress?.session_id === 'string' && typeof progress.epoch === 'string'
        ? { sessionId: progress.session_id, epoch: progress.epoch }
        : null
  }
}

/** Eligibility is a point lookup, shared by raw discovery and finite-pass completion. */
export function journalPruneEpochLookup(
  db: Database.Database
): (sessionId: string) => string | null {
  const statement = db.prepare(`SELECT s.epoch FROM journal_sessions s
LEFT JOIN ${PROGRESS} p ON p.session_id = s.session_id AND p.epoch = s.epoch
WHERE s.session_id = ? AND COALESCE(p.refused, 0) = 0 AND (
  COALESCE(p.scanned, 0) < COALESCE((SELECT r.seq FROM journal_rows r
    WHERE r.session_id = s.session_id AND r.epoch = s.epoch ORDER BY r.seq DESC LIMIT 1), 0)
  OR EXISTS (SELECT 1 FROM ${WORK} w WHERE w.session_id = s.session_id AND w.epoch = s.epoch))`)
  return (sessionId) => {
    const row = statement.get(sessionId)
    return typeof row?.epoch === 'string' ? row.epoch : null
  }
}

export function readJournalPruneSessionPage(
  db: Database.Database,
  cursor: JournalPruneCursor<string>
): string[] {
  return db
    .prepare(`SELECT session_id FROM journal_sessions
WHERE ${cursor.after === null ? '' : 'session_id > ? AND '}session_id <= ?
ORDER BY session_id LIMIT 32`)
    .all(...(cursor.after === null ? [cursor.through] : [cursor.after, cursor.through]))
    .flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}

export class JournalPruneRefusal extends Error {}

export class JournalPruneState implements JournalPruneCandidates {
  constructor(
    private readonly db: Database.Database,
    readonly sessionId: string,
    readonly epoch: string
  ) {}

  initialize(): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO ${PROGRESS} (session_id, epoch) VALUES (?, ?)`)
      .run(this.sessionId, this.epoch)
  }

  progress(): { scanned: number; refused: boolean } {
    const row = this.db
      .prepare(`SELECT scanned, refused FROM ${PROGRESS} WHERE session_id = ? AND epoch = ?`)
      .get(this.sessionId, this.epoch)
    if (typeof row?.scanned !== 'number' || typeof row.refused !== 'number') {
      throw new Error('journal pruning lost its saved frontier')
    }
    return { scanned: row.scanned, refused: row.refused === 1 }
  }

  advance(scanned: number): void {
    this.db
      .prepare(`UPDATE ${PROGRESS} SET scanned = ? WHERE session_id = ? AND epoch = ?`)
      .run(scanned, this.sessionId, this.epoch)
  }

  refuse(): void {
    this.db
      .prepare(`UPDATE ${PROGRESS} SET refused = 1 WHERE session_id = ? AND epoch = ?`)
      .run(this.sessionId, this.epoch)
  }

  get(itemId: string): JournalPruneCandidate | undefined {
    const row = this.db
      .prepare(`SELECT seq, revision, signature, removable, saved_at, observed_at
FROM temp.journal_prune_items WHERE session_id = ? AND epoch = ? AND item_id = ?`)
      .get(this.sessionId, this.epoch, itemId)
    if (!row) {
      return undefined
    }
    if (
      typeof row.seq !== 'number' ||
      typeof row.revision !== 'number' ||
      typeof row.signature !== 'string' ||
      typeof row.removable !== 'number' ||
      typeof row.saved_at !== 'number' ||
      typeof row.observed_at !== 'number'
    ) {
      throw new Error('journal pruning lost its temporary item frontier')
    }
    return {
      seq: row.seq,
      revision: row.revision,
      signature: row.signature,
      removable: row.removable === 1,
      savedAt: row.saved_at,
      observedAt: row.observed_at
    }
  }

  set(itemId: string, candidate: JournalPruneCandidate): void {
    this.db
      .prepare(`INSERT INTO temp.journal_prune_items
(session_id, epoch, item_id, seq, revision, signature, removable, saved_at, observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, epoch, item_id) DO UPDATE SET
seq = excluded.seq, revision = excluded.revision, signature = excluded.signature,
removable = excluded.removable, saved_at = excluded.saved_at, observed_at = excluded.observed_at`)
      .run(
        this.sessionId,
        this.epoch,
        itemId,
        candidate.seq,
        candidate.revision,
        candidate.signature,
        Number(candidate.removable),
        candidate.savedAt,
        candidate.observedAt
      )
  }

  delete(itemId: string): void {
    this.db
      .prepare(`DELETE FROM temp.journal_prune_items
WHERE session_id = ? AND epoch = ? AND item_id = ?`)
      .run(this.sessionId, this.epoch, itemId)
  }

  enqueue(sequence: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO ${WORK}
(session_id, epoch, seq) VALUES (?, ?, ?)`)
      .run(this.sessionId, this.epoch, sequence)
  }

  next(): number | null {
    const seq = this.db
      .prepare(`SELECT seq FROM ${WORK}
WHERE session_id = ? AND epoch = ? ORDER BY seq LIMIT 1`)
      .get(this.sessionId, this.epoch)?.seq
    return typeof seq === 'number' ? seq : null
  }

  consume(sequence: number): void {
    this.db
      .prepare(`DELETE FROM ${WORK}
WHERE session_id = ? AND epoch = ? AND seq = ?`)
      .run(this.sessionId, this.epoch, sequence)
  }
}

/** Only retired or refused keys lose their work. */
export function collectJournalPruneGarbage(
  db: Database.Database,
  transaction: JournalTransaction,
  cursor: JournalPruneCursor<JournalPruneEpoch>
): { collected: boolean; more: boolean } {
  return transaction(() => {
    const { after, through } = cursor
    const rows = db
      .prepare(`SELECT session_id, epoch FROM ${PROGRESS}
WHERE ${after === null ? '' : '(session_id, epoch) > (?, ?) AND '}(session_id, epoch) <= (?, ?)
ORDER BY session_id, epoch LIMIT 32`)
      .all(
        ...(after === null ? [] : [after.sessionId, after.epoch]),
        through.sessionId,
        through.epoch
      )
    const eligible = db.prepare(`SELECT s.epoch AS live, p.refused FROM ${PROGRESS} p
LEFT JOIN journal_sessions s ON s.session_id = p.session_id
WHERE p.session_id = ? AND p.epoch = ? AND (
  s.epoch IS NULL OR s.epoch != p.epoch OR (p.refused = 1 AND (
  EXISTS (SELECT 1 FROM temp.journal_prune_items i WHERE i.session_id = p.session_id AND i.epoch = p.epoch)
  OR EXISTS (SELECT 1 FROM ${WORK} w WHERE w.session_id = p.session_id AND w.epoch = p.epoch))))`)
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || typeof row.epoch !== 'string') {
        throw new Error('journal pruning lost its garbage key')
      }
      const sessionId = row.session_id
      const epoch = row.epoch
      const garbage = eligible.get(sessionId, epoch)
      if (!garbage) {
        cursor.after = { sessionId, epoch }
        continue
      }
      const temporary = db
        .prepare(`DELETE FROM temp.journal_prune_items WHERE session_id = ? AND epoch = ? AND item_id IN (
SELECT item_id FROM temp.journal_prune_items WHERE session_id = ? AND epoch = ? LIMIT 32)`)
        .run(sessionId, epoch, sessionId, epoch)
      if (temporary.changes > 0) {
        return { collected: true, more: true }
      }
      const work = db
        .prepare(`DELETE FROM ${WORK} WHERE session_id = ? AND epoch = ? AND seq IN (
SELECT seq FROM ${WORK} WHERE session_id = ? AND epoch = ? LIMIT 32)`)
        .run(sessionId, epoch, sessionId, epoch)
      if (work.changes === 0 && garbage.live !== epoch) {
        db.prepare(`DELETE FROM ${PROGRESS} WHERE session_id = ? AND epoch = ?`).run(
          sessionId,
          epoch
        )
      }
      return { collected: true, more: true }
    }
    const last = rows.at(-1)
    return {
      collected: false,
      more:
        rows.length === 32 &&
        (last?.session_id !== through.sessionId || last?.epoch !== through.epoch)
    }
  }, 'DEFERRED')
}
