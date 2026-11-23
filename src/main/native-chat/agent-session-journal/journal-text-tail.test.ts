import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import {
  readJournalDomainClientForms,
  readJournalDomainItemDetail
} from './journal-domain-item-presentation'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { runJournalTransaction } from './database/journal-database'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'

const switches = vi.hoisted(() => ({ writes: true }))
vi.mock('./journal-text-tail-writes', () => ({
  get JOURNAL_TEXT_TAIL_WRITES() {
    return switches.writes
  }
}))

const ITEM = 'orca:assistant'
const dirs: string[] = []
afterEach(() => {
  switches.writes = true
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'text-tail-'))
  dirs.push(dir)
  return join(dir, 'journal.db')
}

function tailRows(db: Database.Database): number {
  return Number(db.prepare('SELECT count(1) AS n FROM journal_text_tail').get()!.n)
}

function folded(db: Database.Database): string {
  return String(
    db
      .prepare(`SELECT json_extract(payload_json,'$.body.blocks[0].text') AS text FROM journal_items
        WHERE item_id=?`)
      .get(ITEM)!.text
  )
}

function readText(db: Database.Database) {
  const detail = readJournalDomainItemDetail(db, target, ITEM)!
  const client = readJournalDomainClientForms(db, target, [ITEM]).get(ITEM)!
  const text = (item: typeof detail) => (item.body.kind === 'message' ? item.body.blocks : [])
  return { detail: text(detail), client: text(client.item), revision: detail.revision }
}

it('saves only appended text, reads it whole, and folds at the size bound, a rewrite and item end', async () => {
  const path = store()
  const db = new Database(path)
  const { commit, commitCommands, command } = messageFixture(db)
  let text = ''
  let mostTailRows = 0
  for (let save = 1; save <= 40; save++) {
    text += `line ${save} ${'é'.repeat(save)}\n`
    await commit(message(text))
    const read = readText(db)
    expect(read.detail).toEqual([{ type: 'text', text }])
    expect(read.client).toEqual([{ type: 'text', text }])
    expect(read.revision).toBe(save)
    // Geometric folds keep the folded text at least half of the saved text.
    expect(folded(db).length * 2).toBeGreaterThanOrEqual(text.length)
    mostTailRows = Math.max(mostTailRows, tailRows(db))
  }
  expect(mostTailRows).toBeGreaterThan(3)

  // Text that no longer extends the saved text is written whole.
  text = `rewritten ${text}`
  await commit(message(text))
  expect(tailRows(db)).toBe(0)
  expect(folded(db)).toBe(text)

  text += 'more'
  await commit(message(text))
  expect(tailRows(db)).toBe(1)
  await commitCommands([
    {
      ...command([message(text)]),
      operation: {
        kind: 'steps',
        steps: [
          {
            kind: 'resolved-item',
            resolution: {
              kind: 'text-snapshot',
              identity: message(text).identity,
              body: message(text).body,
              final: true
            },
            options: message(text).options,
            reservedBytes: 2 * text.length + 4096
          }
        ]
      }
    }
  ])
  expect(tailRows(db)).toBe(0)
  expect(folded(db)).toBe(text)

  // A stream that ends without a last save folds when its turn finishes; a thread-scoped one
  // that outlives the turn keeps its tail.
  text += ' and after'
  await commit(message(text))
  const turn = (state: 'running' | 'completed') => ({
    itemId: 'turn',
    revision: state === 'running' ? 1 : 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn' as const, turnId: 'turn', state }
  })
  const writeTurn = (state: 'running' | 'completed') =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, { item: turn(state), hidden: false, ownerFence: 1 })
    )
  writeTurn('running')
  const reply = (body: string) => {
    const step = message(body, 'turn-reply')
    return {
      ...step,
      options: { ...step.options, turnScope: { kind: 'turn' as const, turnItemId: 'turn' } }
    }
  }
  let replyText = 'reply '.repeat(100)
  await commit(reply(replyText))
  replyText += 'more'
  await commit(reply(replyText))
  expect(tailRows(db)).toBe(2)
  writeTurn('completed')
  expect(tailRows(db)).toBe(1)
  expect(folded(db)).not.toBe(text)
  expect(
    db
      .prepare(`SELECT json_extract(payload_json,'$.body.blocks[0].text') AS text FROM journal_items
        WHERE item_id='orca:turn-reply'`)
      .get()!.text
  ).toBe(replyText)
  expect(readText(db).detail).toEqual([{ type: 'text', text }])
  db.close()
})

it('a crash keeps every save; the next open folds it, even with writes off, and older rewrites drop it', async () => {
  const path = store()
  const db = new Database(path)
  const { commit } = messageFixture(db)
  let text = 'start '.repeat(100)
  await commit(message(text))
  for (let save = 0; save < 5; save++) {
    text += `chunk ${save} `
    await commit(message(text))
  }
  expect(tailRows(db)).toBe(5)
  db.close()

  switches.writes = false
  const opened = openJournalDomainDatabase(path)
  expect(tailRows(opened.db)).toBe(0)
  expect(folded(opened.db)).toBe(text)
  expect(readText(opened.db).detail).toEqual([{ type: 'text', text }])
  expect(readText(opened.db).revision).toBe(6)

  // A build without tails rewrites the payload from the folded text; its trigger drops the tail.
  opened.db
    .prepare(
      `INSERT INTO journal_text_tail(session_id,epoch,item_id,seq,text,saved_chars,folded_chars,saved_hash,skeleton)
        VALUES(?,?,?,99,'stale',0,0,'','')`
    )
    .run(target.sessionId, target.epoch, ITEM)
  opened.db.prepare(`UPDATE journal_items SET payload_json=payload_json WHERE item_id=?`).run(ITEM)
  expect(tailRows(opened.db)).toBe(0)
  opened.db
    .prepare(
      `INSERT INTO journal_text_tail(session_id,epoch,item_id,seq,text,saved_chars,folded_chars,saved_hash,skeleton)
        VALUES(?,?,?,99,'stale',0,0,'','')`
    )
    .run(target.sessionId, target.epoch, ITEM)
  opened.db.prepare(`DELETE FROM journal_items WHERE item_id=?`).run(ITEM)
  expect(tailRows(opened.db)).toBe(0)
  opened.db.close()
})

it('a save that ends inside a character is never the base of an append', async () => {
  const db = new Database(store())
  const { commit } = messageFixture(db)
  const base = `${'x'.repeat(400)}${'y'.repeat(10)}`
  await commit(message('x'.repeat(400)))
  await commit(message(`${'x'.repeat(400)}yyyyy`))
  await commit(message(base))
  // A byte snapshot cut mid-emoji decodes to U+FFFD where the emoji's first half will be.
  const cut = new TextDecoder().decode(
    new TextEncoder().encode(`${base}😀`).subarray(0, base.length + 3)
  )
  await commit(message(cut))
  const text = `${base}😀 more`
  await commit(message(text))
  expect(readText(db).detail).toEqual([{ type: 'text', text }])
  db.close()
})

it('never appends onto a saved lone surrogate that reads back as U+FFFD', async () => {
  const db = new Database(store())
  const { commit } = messageFixture(db)
  const base = 'x'.repeat(400)
  await commit(message(`${base}\ud83d`))
  // SQLite reads the stored lone surrogate's three bytes back as three U+FFFD.
  const text = `${base}${'\uFFFD'.repeat(3)} more`
  await commit(message(text))
  expect(readText(db).detail).toEqual([{ type: 'text', text }])
  db.close()
})

it('opens a store whose tail table predates later columns, and keeps streaming into it', async () => {
  const path = store()
  const old = new Database(path)
  old.exec(`CREATE TABLE journal_text_tail (session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    item_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(session_id, epoch, item_id, seq)) WITHOUT ROWID`)
  old.close()
  const db = new Database(path)
  const { commit } = messageFixture(db)
  let text = 'word '.repeat(100)
  for (let save = 0; save < 4; save++) {
    text += `more ${save} `
    await commit(message(text))
  }
  expect(tailRows(db)).toBeGreaterThan(0)
  expect(readText(db).detail).toEqual([{ type: 'text', text }])
  db.close()
})
