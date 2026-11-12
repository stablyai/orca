// Compacts item history written before the journal_outcome_item_supersede trigger, which keeps each
// item's first and newest record; every record between them is superseded and no read reaches it.
// Its own worker and connection: the host's writes never wait behind more than one small page.

import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../../sqlite/sync-database'
import { isTransientSqliteContention } from '../../../sqlite/sqlite-read-failure'
import { createJournalPace, type JournalPace } from './journal-outcome-cleanup'

const ITEM_COMPACTION_TASK = 'item-revisions'

export type ItemCompactionPage = { done: boolean; keys: number; deleted: number }

/** One bounded page in one transaction: items written by builds that kept every revision lose the
 * ones between their first and newest record. The saved cursor commits with the deletions, so a
 * crash or quit resumes after the last committed page. */
export function compactJournalItemRevisionPage(
  db: Database.Database,
  limits: { keys: number; rows: number }
): ItemCompactionPage {
  // Reading the page's records first keeps the write lock to cached pages, not disk reads.
  compactPage(db, limits, false)
  db.exec('BEGIN IMMEDIATE')
  try {
    const page = compactPage(db, limits, true)
    db.exec('COMMIT')
    return page
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function compactPage(
  db: Database.Database,
  limits: { keys: number; rows: number },
  write: boolean
): ItemCompactionPage {
  const saved = db
    .prepare('SELECT generation, entry_key, done FROM journal_maintenance WHERE task = ?')
    .get(ITEM_COMPACTION_TASK)
  if (saved?.done === 1) {
    return { done: true, keys: 0, deleted: 0 }
  }
  let generation = typeof saved?.generation === 'number' ? saved.generation : 0
  let after = typeof saved?.entry_key === 'string' ? saved.entry_key : ''
  const nextGeneration = db.prepare(
    'SELECT generation FROM journal_outcome_generations WHERE generation > ? ORDER BY generation LIMIT 1'
  )
  const keys = db.prepare(`SELECT entry_key, MIN(seq) AS first, MAX(seq) AS newest, COUNT(*) AS n
    FROM journal_outcomes WHERE generation = ? AND field = 'items' AND entry_key > ?
    GROUP BY entry_key ORDER BY entry_key LIMIT ?`)
  // A long-streamed item can hold hundreds of revisions; one page deletes at most `rows` of them.
  const superseded = `FROM journal_outcomes WHERE rowid IN (SELECT rowid FROM journal_outcomes
    WHERE generation = ? AND field = 'items' AND entry_key = ? AND seq > ? AND seq < ?
    ORDER BY seq LIMIT ?)`
  const drop = db.prepare(`DELETE ${superseded}`)
  const read = db.prepare(`SELECT COUNT(*) AS n, SUM(LENGTH(value_json)) AS bytes ${superseded}`)
  let visited = 0
  let deleted = 0
  let done = false
  while (visited < limits.keys && deleted < limits.rows) {
    const batch = generation === 0 ? [] : keys.all(generation, after, limits.keys - visited)
    for (const { entry_key: key, first, newest, n } of batch) {
      if (
        typeof key !== 'string' ||
        typeof first !== 'number' ||
        typeof newest !== 'number' ||
        typeof n !== 'number'
      ) {
        throw new Error('invalid journal item key')
      }
      visited += 1
      const range = [generation, key, first, newest, limits.rows - deleted] as const
      const removed =
        n <= 2 ? 0 : write ? Number(drop.run(...range).changes) : Number(read.get(...range)?.n ?? 0)
      deleted += removed
      if (removed < n - 2) {
        // The next page resumes at this key.
        break
      }
      after = key
      if (deleted >= limits.rows) {
        break
      }
    }
    if (batch.length === 0) {
      const next = nextGeneration.get(generation)?.generation
      if (typeof next !== 'number') {
        done = true
        break
      }
      generation = next
      after = ''
    }
  }
  if (!write) {
    return { done, keys: visited, deleted }
  }
  db.prepare(`INSERT INTO journal_maintenance (task, generation, entry_key, done) VALUES (?, ?, ?, ?)
    ON CONFLICT(task) DO UPDATE SET generation = excluded.generation,
    entry_key = excluded.entry_key, done = excluded.done`).run(
    ITEM_COMPACTION_TASK,
    generation,
    after,
    done ? 1 : 0
  )
  return { done, keys: visited, deleted }
}

const PAGE_LIMITS = { keys: 64, rows: 64 }
const BUSY_RETRY_MS = 250

export type ItemCompactionTotals = { deleted: number; freedBytes: number }

/** Pages to completion at the sweeper's 10% duty cycle. A page that finds the host writing waits and
 * retries, so the host's writes never queue behind more than one small page. */
export async function compactJournalItemRevisions(
  db: Database.Database,
  pace: JournalPace,
  delay: (ms: number) => Promise<void>
): Promise<ItemCompactionTotals> {
  const freePages = () => Number(db.pragma('freelist_count', { simple: true }) ?? 0)
  const freeBefore = freePages()
  let deleted = 0
  for (;;) {
    let page: ItemCompactionPage
    try {
      page = pace.work(() => compactJournalItemRevisionPage(db, PAGE_LIMITS))
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
  }
}

if (parentPort) {
  const port = parentPort
  const request: unknown = workerData
  if (
    typeof request !== 'object' ||
    request === null ||
    !('databasePath' in request) ||
    typeof request.databasePath !== 'string'
  ) {
    throw new Error('Invalid chat history compaction request')
  }
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  // No busy wait: a page that finds the host writing backs off instead of holding it up.
  const db = new Database(request.databasePath, { fileMustExist: true, timeout: 0 })
  // A page lost to power failure is redone by the next pass; WAL keeps the database consistent.
  db.pragma('synchronous = NORMAL')
  void compactJournalItemRevisions(
    db,
    createJournalPace(() => performance.now(), delay),
    delay
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
