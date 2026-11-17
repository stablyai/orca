import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { openJournalLegacySource } from './journal-legacy-source'
import { readJournalStoreMeta, writeJournalStoreMeta } from './journal-store-meta'
import {
  captureJournalLegacySourceReceipt,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'

/** Set once every original chat's person edits have a baseline here. */
export const JOURNAL_LEGACY_PERSON_EDITS_KEPT = 'journal.legacy-person-edits-kept.v1'

/**
 * What a person edits on a chat's record, each group taken whole. An older build rewrites every
 * record's lease and `updatedAt` at launch, so only these fields, compared with what this file
 * last read from the original, say the older build was used to edit the chat.
 */
const PERSON_EDITS = [
  ['conversationName', 'conversationNameSource'],
  ['options'],
  ['permissionMode']
]
const PERSON_FIELDS = PERSON_EDITS.flat()
function personEditsSql(json: string): string {
  return `CASE WHEN json_valid(${json}) THEN json_extract(${json},
    ${PERSON_FIELDS.map((field) => `'$.${field}'`).join(',')}) END`
}

function personEditsKey(sessionId: string): string {
  return `journal.legacy-person-edits:${sessionId}`
}

/** Each chat's person edits in `records`, as the baseline later launches compare with. */
export function recordJournalLegacyPersonEdits(
  records: Database.Database,
  db: Database.Database
): void {
  for (const [id, edits] of readPersonEdits(records)) {
    writeJournalStoreMeta(db, personEditsKey(id), edits)
  }
}

/**
 * Once, for a file kept before person edits were: the original is as last read, so its edits are
 * exactly the baseline a later downgrade's renames compare with. Kept only if the original is still
 * as read, so an edit made there meanwhile is never taken as already seen.
 */
export function keepJournalLegacyPersonEdits(
  sourcePath: string,
  db: Database.Database,
  savedReceipt: string | undefined
): void {
  if (readJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT) !== undefined) {
    return
  }
  const source = openJournalLegacySource(sourcePath)
  let keep: (() => void) | null
  try {
    keep = journalLegacyPersonEditsBaseline(source, db)
  } finally {
    source.close()
  }
  if (!sameJournalLegacySource(savedReceipt, captureJournalLegacySourceReceipt(sourcePath))) {
    return
  }
  if (keep) {
    runJournalTransaction(db, keep)
  }
}

/** The write that keeps the original's person edits, read now, as their baseline; null once kept. */
export function journalLegacyPersonEditsBaseline(
  source: Database.Database,
  db: Database.Database
): (() => void) | null {
  if (readJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT) !== undefined) {
    return null
  }
  const edits = readPersonEdits(source)
  return () => {
    for (const [id, value] of edits) {
      writeJournalStoreMeta(db, personEditsKey(id), value)
    }
    writeJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT, '1')
  }
}

function readPersonEdits(records: Database.Database): [string, string][] {
  const edits: [string, string][] = []
  for (const row of records
    .prepare(
      `SELECT session_id, ${personEditsSql('record_json')} AS edits FROM agent_session_records`
    )
    .iterate()) {
    if (typeof row.edits === 'string') {
      edits.push([String(row.session_id), row.edits])
    }
  }
  return edits
}

/**
 * Adds the write that takes the edits a person made to a chat's record in the older Orca since this
 * file last read it, if any; a pass runs its writes together in one transaction.
 */
export function takeOlderOrcaRecordEdits(
  source: Database.Database,
  db: Database.Database,
  sessionId: string,
  writes: (() => void)[]
): void {
  const write = olderOrcaRecordEditsWrite(source, db, sessionId)
  if (write) {
    writes.push(write)
  }
}

/** Runs a pass's record edits in one transaction; false when one failed, so the pass retries. */
export function applyOlderOrcaRecordEdits(
  db: Database.Database,
  writes: readonly (() => void)[]
): boolean {
  if (writes.length === 0) {
    return true
  }
  let applied = true
  runJournalTransaction(db, () => {
    // Each chat's record and baseline land together or not at all.
    for (const write of writes) {
      db.exec('SAVEPOINT older_orca_edit')
      try {
        write()
        db.exec('RELEASE older_orca_edit')
      } catch (error) {
        db.exec('ROLLBACK TO older_orca_edit')
        db.exec('RELEASE older_orca_edit')
        applied = false
        console.warn('[agent-session-journal] keeping an older Orca chat edit failed', error)
      }
    }
  })
  return applied
}

function olderOrcaRecordEditsWrite(
  source: Database.Database,
  db: Database.Database,
  sessionId: string
): (() => void) | null {
  // Only the fields, read once: nothing here takes the record itself.
  const row = source
    .prepare(
      `SELECT ${personEditsSql('record_json')} AS edits FROM agent_session_records WHERE session_id=?`
    )
    .get(sessionId)
  const edited = olderOrcaPersonEdits(db, sessionId, row?.edits)
  if (!edited) {
    return null
  }
  // Nothing edited there: this file's record stays as it is, unread.
  const current = edited.changed.size > 0 ? recordHere(db, sessionId) : null
  const next = current && withFields(current, edited.older, edited.changed)
  if (next === current && edited.saved === edited.edits) {
    return null
  }
  return () => {
    if (next && next !== current) {
      db.prepare('UPDATE agent_session_records SET record_json=? WHERE session_id=?').run(
        JSON.stringify(next),
        sessionId
      )
    }
    keepBaseline(db, sessionId, edited)
  }
}

/** The original's edits now go to a copy of the chat, so the chat here leaves them as they are. */
export function passOlderOrcaRecordEditsToCopy(
  db: Database.Database,
  sessionId: string,
  original: string
): void {
  const edited = olderOrcaPersonEdits(db, sessionId, personEditsOf(db, original))
  if (edited) {
    keepBaseline(db, sessionId, edited)
  }
}

/**
 * The older build's record for a chat it added messages to, as the build that ran it last, keeping
 * this file's person edits wherever the older build left them as this file last read them.
 */
export function olderOrcaRecordKeepingEditsHere(
  db: Database.Database,
  sessionId: string,
  original: string
): string {
  const older = parseRecord(original)
  const current = recordHere(db, sessionId)
  const edited = olderOrcaPersonEdits(db, sessionId, personEditsOf(db, original))
  if (edited) {
    keepBaseline(db, sessionId, edited)
  }
  if (!older || !current) {
    return original
  }
  // Automatic naming there never replaces a person's name here.
  const nameHere =
    current.conversationNameSource === 'user' && older.conversationNameSource !== 'user'
  const unchanged = PERSON_FIELDS.filter(
    (field) => !edited?.changed.has(field) || (nameHere && field.startsWith('conversationName'))
  )
  return JSON.stringify(withFields(older, current, new Set(unchanged)))
}

/** Writes the baseline only when it moved, so an unchanged original costs a read, not a write. */
function keepBaseline(
  db: Database.Database,
  sessionId: string,
  edited: { edits: string; saved: string | undefined }
): void {
  if (edited.saved !== edited.edits) {
    writeJournalStoreMeta(db, personEditsKey(sessionId), edited.edits)
  }
}

/** A record's person edits, from the very text a chat takes, so its baseline is what is taken. */
function personEditsOf(db: Database.Database, record: string): unknown {
  return db.prepare(`SELECT ${personEditsSql('?1')} AS edits`).get(record)?.edits
}

/** Which person-edit fields the older build changed since this file last read the original. */
function olderOrcaPersonEdits(
  db: Database.Database,
  sessionId: string,
  edits: unknown
): {
  edits: string
  saved: string | undefined
  older: Record<string, unknown>
  changed: Set<string>
} | null {
  if (typeof edits !== 'string') {
    return null
  }
  const saved = readJournalStoreMeta(db, personEditsKey(sessionId))
  const older = fieldsOf(edits)
  const changed = new Set<string>()
  // With no baseline nothing says which build changed a field, so this file's value stays.
  if (saved !== undefined && saved !== edits) {
    const before = fieldsOf(saved)
    for (const group of PERSON_EDITS) {
      if (group.some((field) => !same(before[field], older[field]))) {
        group.forEach((field) => changed.add(field))
      }
    }
  }
  return { edits, saved, older, changed }
}

/** `onto` with `from`'s value for each named field; the same object when nothing changes. */
function withFields(
  onto: Record<string, unknown>,
  from: Record<string, unknown>,
  fields: ReadonlySet<string>
): Record<string, unknown> {
  // Automatic naming never replaces a person's name, as in either build itself.
  const keepName = onto.conversationNameSource === 'user' && from.conversationNameSource !== 'user'
  const next: Record<string, unknown> = { ...onto }
  let changed = false
  for (const field of fields) {
    if ((keepName && field.startsWith('conversationName')) || same(onto[field], from[field])) {
      continue
    }
    if (from[field] === undefined || from[field] === null) {
      delete next[field]
    } else {
      next[field] = from[field]
    }
    changed = true
  }
  return changed ? next : onto
}

function recordHere(db: Database.Database, sessionId: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  return row === undefined ? null : parseRecord(String(row.record_json))
}

function fieldsOf(edits: string): Record<string, unknown> {
  const values = parseJson(edits)
  return Array.isArray(values)
    ? Object.fromEntries(PERSON_FIELDS.map((field, index) => [field, values[index] ?? undefined]))
    : {}
}

function parseRecord(json: string): Record<string, unknown> | null {
  const value = parseJson(json)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
