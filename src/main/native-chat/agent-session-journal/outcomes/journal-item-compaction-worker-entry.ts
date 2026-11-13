// Old revision histories are read and admitted before taking a short, bounded write transaction.

import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../../sqlite/sync-database'
import { isTransientSqliteContention } from '../../../sqlite/sqlite-read-failure'
import { createJournalPace, type JournalPace } from './journal-outcome-cleanup'
import { decodeJournalOutcome } from './journal-outcome-codec'
import {
  journalOutcomeSource,
  JOURNAL_OUTCOME_FORMAT,
  JOURNAL_OUTCOME_MARKER_VERSION
} from './journal-outcome-format'
import { journalCompactionIsIdle } from './journal-compaction-activity'
import {
  AgentSessionJournalError,
  JournalOutcomeDecodeError
} from '../writing/journal-write-guards'

// A build that admits newer contracts must revisit generations this build skipped.
const ITEM_COMPACTION_TASK = `item-revisions-${JOURNAL_OUTCOME_FORMAT}-${JOURNAL_OUTCOME_MARKER_VERSION}`
const PAGE_LIMITS = { keys: 1, rows: 8, readRows: 64 }
export type ItemCompactionPage = { done: boolean; keys: number; deleted: number }
type Position = {
  generation: number
  key: string
  done: boolean
  admission?: { source: string; seq: number; field: string; key: string; done: boolean }
}

function position(db: Database.Database): Position {
  const saved = db
    .prepare('SELECT generation, entry_key, done FROM journal_maintenance WHERE task = ?')
    .get(ITEM_COMPACTION_TASK)
  return {
    generation: typeof saved?.generation === 'number' ? saved.generation : 0,
    key: '',
    ...(typeof saved?.entry_key === 'string' && saved.entry_key ? JSON.parse(saved.entry_key) : {}),
    done: saved?.done === 1
  }
}

/** Indexed endpoints and a bounded middle window; no aggregate scans the rest of a hot key. */
export function compactJournalItemRevisionPage(
  db: Database.Database,
  limits: { keys: number; rows: number; readRows?: number },
  canWrite: () => boolean = () => true
): ItemCompactionPage {
  if (limits.keys < 1 || limits.rows < 1) {
    throw new Error('invalid compaction budget')
  }
  const paused = { done: false, keys: 0, deleted: 0 }
  if (!canWrite()) {
    return paused
  }
  const saved = position(db)
  if (saved.done) {
    return { done: true, keys: 0, deleted: 0 }
  }
  const next = { ...saved }
  const advance = () => {
    const generation = db
      .prepare(`SELECT generation FROM journal_outcome_generations
      WHERE generation > ? ORDER BY generation LIMIT 1`)
      .get(saved.generation)?.generation
    next.generation = typeof generation === 'number' ? generation : saved.generation
    next.key = ''
    delete next.admission
    next.done = typeof generation !== 'number'
  }
  const owner = db
    .prepare(`SELECT session_id, epoch FROM journal_outcome_generations
    WHERE generation = ?`)
    .get(saved.generation)
  const source = () => {
    if (typeof owner?.session_id !== 'string' || typeof owner.epoch !== 'string') {
      return null
    }
    try {
      const admitted = journalOutcomeSource(db, owner.session_id, owner.epoch)
      return admitted?.generation === saved.generation ? admitted : null
    } catch (error) {
      if (
        !(error instanceof AgentSessionJournalError) &&
        !(error instanceof JournalOutcomeDecodeError)
      ) {
        throw error
      }
      return null
    }
  }
  const admitted = source()
  let keys = 0
  let sequences: number[] = []
  let candidateKey = ''
  if (!admitted) {
    advance()
  } else if (!saved.admission?.done || saved.admission.source !== JSON.stringify(admitted)) {
    const after = saved.admission?.source === JSON.stringify(admitted) ? saved.admission : null
    const readRows = limits.readRows ?? limits.rows
    const records = db
      .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes WHERE generation = ? AND (seq, field, entry_key) > (?, ?, ?)
      ORDER BY seq, field, entry_key LIMIT ?`)
      .all(saved.generation, after?.seq ?? 0, after?.field ?? '', after?.key ?? '', readRows)
    try {
      for (const record of records) {
        decodeJournalOutcome(record)
      }
      const last = records.at(-1)
      next.key = ''
      next.admission = {
        source: JSON.stringify(admitted),
        seq: Number(last?.seq ?? after?.seq ?? 0),
        field: String(last?.field ?? ''),
        key: String(last?.entry_key ?? ''),
        done: records.length < readRows
      }
    } catch (error) {
      if (
        !(error instanceof AgentSessionJournalError) &&
        !(error instanceof JournalOutcomeDecodeError)
      ) {
        throw error
      }
      advance()
    }
  } else {
    const newest = db
      .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key > ?
      ORDER BY entry_key, seq DESC LIMIT 1`)
      .get(saved.generation, saved.key)
    if (!newest || typeof newest.entry_key !== 'string' || typeof newest.seq !== 'number') {
      advance()
    } else {
      keys = 1
      const key = newest.entry_key
      candidateKey = key
      const first = db
        .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
        FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key = ?
        ORDER BY seq LIMIT 1`)
        .get(saved.generation, key)
      const middle = db
        .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
        FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key = ?
        AND seq > ? AND seq < ? ORDER BY seq LIMIT ?`)
        .all(saved.generation, key, first?.seq ?? newest.seq, newest.seq, limits.rows + 1)
      next.key = middle.length > limits.rows ? saved.key : key
      try {
        for (const record of [first, newest, ...middle]) {
          if (!record) {
            throw new Error('missing item endpoint')
          }
          decodeJournalOutcome(record)
        }
        sequences = middle.slice(0, limits.rows).map((record) => Number(record.seq))
      } catch (error) {
        if (
          !(error instanceof AgentSessionJournalError) &&
          !(error instanceof JournalOutcomeDecodeError)
        ) {
          throw error
        }
        // Unknown fields and formats are never inferred to be whole-value replacements.
        next.key = key
      }
    }
  }
  if (!canWrite()) {
    return paused
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = position(db)
    let deleted = 0
    if (
      canWrite() &&
      JSON.stringify(current) === JSON.stringify(saved) &&
      JSON.stringify(source()) === JSON.stringify(admitted)
    ) {
      const drop = db.prepare(`DELETE FROM journal_outcomes
        WHERE generation = ? AND field = 'items' AND entry_key = ? AND seq = ?`)
      for (const seq of sequences) {
        deleted += Number(drop.run(saved.generation, candidateKey, seq).changes)
      }
      db.prepare(`INSERT INTO journal_maintenance (task, generation, entry_key, done) VALUES (?, ?, ?, ?)
        ON CONFLICT(task) DO UPDATE SET generation = excluded.generation,
        entry_key = excluded.entry_key, done = excluded.done`).run(
        ITEM_COMPACTION_TASK,
        next.generation,
        JSON.stringify({ key: next.key, admission: next.admission }),
        Number(next.done)
      )
    } else {
      db.exec('ROLLBACK')
      return paused
    }
    db.exec('COMMIT')
    return { done: next.done, keys, deleted }
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}

const BUSY_RETRY_MS = 250

export type ItemCompactionTotals = { deleted: number; freedBytes: number }

/** Pause on serving activity, with a yield between every page and a 10% maintenance duty cycle. */
export async function compactJournalItemRevisions(
  db: Database.Database,
  pace: JournalPace,
  delay: (ms: number) => Promise<void>,
  canWrite: () => boolean = () => true
): Promise<ItemCompactionTotals> {
  const freePages = () => Number(db.pragma('freelist_count', { simple: true }) ?? 0)
  const freeBefore = freePages()
  let deleted = 0
  for (;;) {
    if (!canWrite()) {
      await delay(BUSY_RETRY_MS)
      continue
    }
    let page: ItemCompactionPage
    try {
      page = pace.work(() => compactJournalItemRevisionPage(db, PAGE_LIMITS, canWrite))
    } catch (error) {
      if (!isTransientSqliteContention(error)) {
        throw error
      }
      await delay(BUSY_RETRY_MS)
      continue
    }
    deleted += page.deleted
    if (page.done) {
      const pageSize = Number(db.pragma('page_size', { simple: true }) ?? 0)
      return { deleted, freedBytes: Math.max(0, freePages() - freeBefore) * pageSize }
    }
    await pace.rest()
    await delay(25)
  }
}

if (parentPort) {
  const port = parentPort
  const request: unknown = workerData
  if (
    typeof request !== 'object' ||
    request === null ||
    !('databasePath' in request) ||
    typeof request.databasePath !== 'string' ||
    !('activityBuffer' in request) ||
    !(request.activityBuffer instanceof SharedArrayBuffer)
  ) {
    throw new Error('Invalid chat history compaction request')
  }
  const activity = new BigInt64Array(request.activityBuffer)
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  // No busy wait: a page that finds the host writing backs off instead of holding it up.
  const db = new Database(request.databasePath, { fileMustExist: true, timeout: 0 })
  // A page lost to power failure is redone by the next pass; WAL keeps the database consistent.
  db.pragma('synchronous = NORMAL')
  void compactJournalItemRevisions(
    db,
    createJournalPace(() => performance.now(), delay),
    delay,
    () => journalCompactionIsIdle(activity)
  )
    .then(
      (totals) => port.postMessage({ ok: true, ...totals }),
      (error: unknown) => port.postMessage({ ok: false, error: String(error) })
    )
    .finally(() => {
      db.close()
      port.close()
    })
}
