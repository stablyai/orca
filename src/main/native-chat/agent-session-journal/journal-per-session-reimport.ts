// A per-chat file that reappears after its chat was copied in: an older build, run after a
// downgrade, attached the chat and wrote its history there.
//
// `journal_imports` records which file each chat was copied from — its epoch and tip — in the
// transaction that publishes the verified copy. A file still at that epoch and tip was already
// copied (only its delete failed, or a crash came first, across any number of restarts): it is
// deleted, never copied again. This build's history always wins: once a chat has been copied or
// founded here, any other file is set aside, left on disk as it is, and recorded in
// `journal_set_aside`, so no later open reads it again.

import type Database from '../../sqlite/sync-database'

export type PerSessionJournalHead = { epoch: string; tip: number }

const SELECT_MARKER = 'SELECT epoch, tip FROM journal_imports WHERE session_id = ?'
const UPSERT_MARKER = `INSERT INTO journal_imports (session_id, epoch, tip) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, tip = excluded.tip`

export function readPerSessionImportMarker(
  db: Database.Database,
  sessionId: string
): PerSessionJournalHead | null {
  const row = db.prepare(SELECT_MARKER).get(sessionId)
  return typeof row?.epoch === 'string' && typeof row.tip === 'number'
    ? { epoch: row.epoch, tip: row.tip }
    : null
}

const SELECT_SET_ASIDE = 'SELECT 1 AS present FROM journal_set_aside WHERE session_id = ?'
const INSERT_SET_ASIDE = `INSERT INTO journal_set_aside (session_id, epoch, tip) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO NOTHING`

export function isPerSessionJournalSetAside(db: Database.Database, sessionId: string): boolean {
  return db.prepare(SELECT_SET_ASIDE).get(sessionId) !== undefined
}

/** Records a file that is not this build's history, as it was when set aside. */
export function setAsidePerSessionJournal(
  db: Database.Database,
  sessionId: string,
  head: PerSessionJournalHead
): void {
  db.prepare(INSERT_SET_ASIDE).run(sessionId, head.epoch, head.tip)
}

export function writePerSessionImportMarker(
  db: Database.Database,
  sessionId: string,
  head: PerSessionJournalHead
): void {
  db.prepare(UPSERT_MARKER).run(sessionId, head.epoch, head.tip)
}

export type PerSessionImportPlan =
  | { kind: 'first' }
  | { kind: 'copied' }
  /** Not this build's history: set aside, neither copied nor deleted. */
  | { kind: 'kept' }

/** What a present per-chat file owes this chat, judged against what was last copied from it. */
export function planPerSessionImport(input: {
  db: Database.Database
  sessionId: string
  legacy: PerSessionJournalHead
  /** The chat already has an epoch in the host's database. */
  published: boolean
}): PerSessionImportPlan {
  const marker = readPerSessionImportMarker(input.db, input.sessionId)
  if (marker?.epoch === input.legacy.epoch && marker.tip === input.legacy.tip) {
    return { kind: 'copied' }
  }
  return !marker && !input.published ? { kind: 'first' } : { kind: 'kept' }
}
