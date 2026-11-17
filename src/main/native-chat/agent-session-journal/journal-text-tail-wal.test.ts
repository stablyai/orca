// WAL bytes written while answers stream as 400 ms text saves, with and without appended tails.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import {
  readJournalDomainClientForms,
  readJournalDomainItemDetail
} from './journal-domain-item-presentation'
import { hydrateJournalTextTail } from './journal-text-tail'
import { runJournalTransaction } from './database/journal-database'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const switches = vi.hoisted(() => ({ writes: true }))
vi.mock('./journal-text-tail-writes', () => ({
  get JOURNAL_TEXT_TAIL_WRITES() {
    return switches.writes
  }
}))
afterEach(() => {
  switches.writes = true
})

// A 100 KB answer arrives as 150 saves, so every answer grows by the same text per save.
const CHARS_PER_SAVE = Math.ceil((100 * 1024) / 150)

async function streamWal(tails: boolean, answers: number, kib: number) {
  switches.writes = tails
  const dir = mkdtempSync(join(tmpdir(), 'text-tail-wal-'))
  const path = join(dir, 'journal.db')
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    const { commit } = messageFixture(db)
    const before = statSync(`${path}-wal`).size
    const saves = Math.ceil((kib * 1024) / CHARS_PER_SAVE)
    const started = performance.now()
    for (let save = 1; save <= saves; save++) {
      const text = 'word '.repeat(Math.ceil((save * CHARS_PER_SAVE) / 5))
      for (let answer = 0; answer < answers; answer++) {
        await commit(message(text, `assistant-${answer}`))
      }
    }
    const walBytes = statSync(`${path}-wal`).size - before
    return {
      tails,
      answers,
      kib,
      saves,
      walMB: +(walBytes / 2 ** 20).toFixed(2),
      walMBPerAnswer: +(walBytes / answers / 2 ** 20).toFixed(2),
      ms: Math.round(performance.now() - started)
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Timeout: streams 750 real SQLite commits to a file database in WAL mode.
it(
  'appended tails write WAL linear in answer length and well under whole rewrites',
  { timeout: 300_000 },
  async () => {
    const rewrite = await streamWal(false, 1, 100)
    const tail = await streamWal(true, 1, 100)
    const longTail = await streamWal(true, 1, 400)
    console.log(JSON.stringify([rewrite, tail, longTail]))
    expect(tail.walMB * 2).toBeLessThan(rewrite.walMB)
    // Four times the text costs about four times the WAL, not sixteen.
    expect(longTail.walMB).toBeLessThan(tail.walMB * 5)
  }
)

/** Rows and saved text each statement over the tail table or the folded text hands back. */
function countTailReads(db: Database.Database) {
  const reads = { statements: 0, tailRows: 0, foldedChars: 0, sql: new Set<string>() }
  const wrapped = new WeakSet<object>()
  const prepare = db.prepare.bind(db)
  db.prepare = (sql: string) => {
    const statement = prepare(sql)
    const tail = sql.includes('FROM journal_text_tail')
    const folded = sql.includes('AS folded')
    if ((tail || folded) && !wrapped.has(statement)) {
      wrapped.add(statement)
      const count = (rows: Record<string, unknown>[]) => {
        reads.statements++
        reads.sql.add(sql)
        if (tail) {
          reads.tailRows += rows.length
        }
        for (const row of rows) {
          reads.foldedChars += typeof row.folded === 'string' ? row.folded.length : 0
        }
      }
      const get = statement.get.bind(statement)
      const all = statement.all.bind(statement)
      statement.get = (...args: Parameters<typeof get>) => {
        const row = get(...args)
        count(row ? [row] : [])
        return row
      }
      statement.all = (...args: Parameters<typeof all>) => {
        const rows = all(...args)
        count(rows)
        return rows
      }
    }
    return statement
  }
  return reads
}

async function streamReads(saves: number) {
  const db = new Database(':memory:')
  const { commit } = messageFixture(db)
  const reads = countTailReads(db)
  let text = ''
  for (let save = 1; save <= saves; save++) {
    text += 'word '.repeat(20)
    await commit(message(text))
  }
  db.close()
  return { saves, chars: text.length, tailRows: reads.tailRows, foldedChars: reads.foldedChars }
}

it('each save reads one tail row, and folded text once per fold', async () => {
  const short = await streamReads(100)
  const long = await streamReads(1000)
  console.log(JSON.stringify([short, long]))
  for (const run of [short, long]) {
    // The newest row only (empty at the first save after a fold), never every earlier row.
    expect(run.tailRows).toBeLessThanOrEqual(run.saves)
    // Folds double the folded text, so the folded reads sum to under twice the final text.
    expect(run.foldedChars).toBeLessThan(2 * run.chars)
  }
})

it('a finished turn reads only its own tails, however many items or other tails the chat holds', async () => {
  const finish = async (width: number) => {
    const db = new Database(':memory:')
    const { commit, seedItem } = messageFixture(db)
    const turn = (state: 'running' | 'completed', revision: number): AgentJournalRenderItem => ({
      itemId: 'turn',
      revision,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'turn', turnId: 'turn', state }
    })
    const write = (item: AgentJournalRenderItem, previous?: AgentJournalRenderItem) =>
      runJournalTransaction(db, () =>
        writeJournalDomainCurrentItem(db, target, {
          item,
          hidden: false,
          ownerFence: 1,
          ...(previous ? { previous: { item: previous, ordinal: 1, hidden: false } } : {})
        })
      )
    write(turn('running', 1))
    // `width` finished items of this turn without tails, and `width` streams of other scopes
    // whose tails outlive it.
    for (let index = 0; index < width; index++) {
      seedItem({
        itemId: `orca:done-${index}`,
        revision: 1,
        sequence: 20 + index,
        observedAt: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
        turnScope: { kind: 'turn', turnItemId: 'turn' }
      })
      const other = 'word '.repeat(80)
      await commit(message(other, `thread-${index}`))
      await commit(message(`${other}more`, `thread-${index}`))
    }
    const own = (text: string) => {
      const step = message(text, 'own')
      return {
        ...step,
        options: { ...step.options, turnScope: { kind: 'turn' as const, turnItemId: 'turn' } }
      }
    }
    await commit(own('word '.repeat(80)))
    await commit(own(`${'word '.repeat(80)}more`))
    const reads = countTailReads(db)
    write(turn('completed', 2), turn('running', 1))
    const result = { statements: reads.statements, tailRows: reads.tailRows }
    const pending = Number(
      db.prepare('SELECT count(DISTINCT item_id) AS n FROM journal_text_tail').get()!.n
    )
    db.close()
    return { ...result, pending }
  }
  for (const width of [100, 1000]) {
    // One indexed discovery naming only the turn's own pending item, and the fold's read of
    // that item's tail; the others keep their tails.
    expect(await finish(width)).toEqual({ statements: 2, tailRows: 2, pending: width })
  }
})

// Timeout: the opt-in fleet bench writes about 3 GB of WAL across 47,000 commits.
it.runIf(process.env.ORCA_TEXT_TAIL_WAL_BENCH === '1')(
  'reports WAL at fleet scale and for long answers',
  { timeout: 3_600_000 },
  async () => {
    for (const [answers, kib] of [
      [150, 100],
      [1, 1024]
    ]) {
      for (const tails of [false, true]) {
        console.log(JSON.stringify(await streamWal(tails, answers, kib)))
      }
    }
    // Each read of a finished assistant item probes the (empty) tail table once.
    const db = new Database(':memory:')
    const { commit } = messageFixture(db)
    const ids = Array.from({ length: 1000 }, (_, index) => `assistant-${index}`)
    for (const id of ids) {
      await commit(message('word '.repeat(400), id))
    }
    const page = ids.map((id) => `orca:${id}`)
    readJournalDomainClientForms(db, target, page)
    const started = performance.now()
    for (let run = 0; run < 20; run++) {
      readJournalDomainClientForms(db, target, page)
    }
    const msPerPage = (performance.now() - started) / 20
    const items = page.map((id) => readJournalDomainItemDetail(db, target, id)!)
    const probed = performance.now()
    for (let run = 0; run < 20; run++) {
      items.forEach((item) => hydrateJournalTextTail(db, [target.sessionId, target.epoch], item))
    }
    const msProbesPerPage = (performance.now() - probed) / 20
    console.log(JSON.stringify({ historyPageItems: 1000, msPerPage, msProbesPerPage }))
    db.close()
  }
)
