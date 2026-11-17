// WAL bytes written while answers stream as 400 ms text saves, with and without appended tails.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { message, messageFixture } from './journal-sql-message.test-fixture'

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

it('appended tails write WAL linear in answer length and well under whole rewrites', async () => {
  const rewrite = await streamWal(false, 1, 100)
  const tail = await streamWal(true, 1, 100)
  const longTail = await streamWal(true, 1, 400)
  console.log(JSON.stringify([rewrite, tail, longTail]))
  expect(tail.walMB * 2).toBeLessThan(rewrite.walMB)
  // Four times the text costs about four times the WAL, not sixteen.
  expect(longTail.walMB).toBeLessThan(tail.walMB * 5)
}, 300_000)

it.runIf(process.env.ORCA_TEXT_TAIL_WAL_BENCH === '1')(
  'reports WAL at fleet scale and for long answers',
  async () => {
    for (const [answers, kib] of [
      [150, 100],
      [1, 1024]
    ]) {
      for (const tails of [false, true]) {
        console.log(JSON.stringify(await streamWal(tails, answers, kib)))
      }
    }
  },
  3_600_000
)
