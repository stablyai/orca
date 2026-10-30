import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import SyncDatabase from '../sqlite/sync-database'
import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'

// Compare identical large-WAL opens inline and in a worker; relative timings avoid fixed runner-speed assumptions.

const PAGE_SIZE = 512
const TRANSACTIONS = 2_400
const ROWS_PER_TRANSACTION = 5
const MIN_WAL_BYTES = 40_000_000
const TOKEN = 'event-loop-token'
const TIMER_INTERVAL_MS = 5

let root = ''
let workerEntryPath = ''

function stateDbPath(name: string): string {
  return join(root, `${name}.vscdb`)
}

/** Leave WAL frames but remove shm so the next opener must rebuild the index. */
function writeLargeWalFixture(): void {
  const path = stateDbPath('worker')
  const writer = new SyncDatabase(path)
  writer.exec(`PRAGMA page_size = ${PAGE_SIZE}`)
  writer.exec('PRAGMA journal_mode = WAL')
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  writer.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  insert.run('cursorAuth/accessToken', TOKEN)
  const padding = new Uint8Array(4_000).fill(7)
  for (let tx = 0; tx < TRANSACTIONS; tx++) {
    writer.exec('BEGIN')
    for (let row = 0; row < ROWS_PER_TRANSACTION; row++) {
      insert.run(`padding/${tx}/${row}`, padding)
    }
    writer.exec('COMMIT')
  }
  const holder = new SyncDatabase(path, { readonly: true })
  holder.prepare('SELECT count(*) AS n FROM ItemTable').get()
  writer.close()
  holder.close()
  rmSync(`${path}-shm`, { force: true })
  copyFileSync(path, stateDbPath('inline'))
  copyFileSync(`${path}-wal`, `${stateDbPath('inline')}-wal`)
}

function readTokenInline(path: string): string | null {
  const db = new SyncDatabase(path, { readonly: true, fileMustExist: true, timeout: 250 })
  try {
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('cursorAuth/accessToken')
    return typeof row?.value === 'string' ? row.value : null
  } finally {
    db.close()
  }
}

type Measured<T> = { value: T; activeMs: number; wallMs: number; maxTimerLatenessMs: number }

async function measure<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  let maxTimerLatenessMs = 0
  let expectedAt = performance.now() + TIMER_INTERVAL_MS
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    const now = performance.now()
    maxTimerLatenessMs = Math.max(maxTimerLatenessMs, now - expectedAt)
    expectedAt = now + TIMER_INTERVAL_MS
    timer = setTimeout(tick, TIMER_INTERVAL_MS)
  }
  timer = setTimeout(tick, TIMER_INTERVAL_MS)
  // Arm the timer before opening so inline stalls register as lateness.
  await new Promise((done) => setTimeout(done, TIMER_INTERVAL_MS * 2))
  const before = performance.eventLoopUtilization()
  const startedAt = performance.now()
  const value = await fn()
  // Let a post-read tick observe any stall that just ended.
  await new Promise((done) => setTimeout(done, TIMER_INTERVAL_MS * 2))
  const wallMs = performance.now() - startedAt
  const activeMs = performance.eventLoopUtilization(before).active
  if (timer) {
    clearTimeout(timer)
  }
  return { value, activeMs, wallMs, maxTimerLatenessMs }
}

function describeArm(label: string, arm: Measured<unknown>): string {
  return `${label}: active ${arm.activeMs.toFixed(1)}ms, wall ${arm.wallMs.toFixed(1)}ms, worst timer lateness ${arm.maxTimerLatenessMs.toFixed(1)}ms`
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-foreign-sqlite-event-loop-'))
  writeLargeWalFixture()
  workerEntryPath = join(root, 'foreign-sqlite-reader-entry.cjs')
  // Bundle the production reader source because Worker requires emitted JavaScript.
  await build({
    entryPoints: [resolve(__dirname, 'foreign-sqlite-reader-entry.ts')],
    outfile: workerEntryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'error'
  })
}, 120_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('foreign SQLite reader event-loop occupancy', () => {
  it('keeps the calling thread responsive while a large-WAL open blocks the worker', async () => {
    // A checkpointed-away WAL would make the test pass without exercising a slow open.
    expect(statSync(`${stateDbPath('worker')}-wal`).size).toBeGreaterThan(MIN_WAL_BYTES)
    expect(statSync(`${stateDbPath('inline')}-wal`).size).toBeGreaterThan(MIN_WAL_BYTES)

    const client = new ForeignSqliteReaderClient({
      workerFactory: () => new Worker(workerEntryPath),
      log: () => {}
    })
    try {
      // Exclude worker startup from the measured database-open interval.
      await expect(client.readCursorProfile(join(root, 'absent.vscdb'))).resolves.toEqual({
        status: 'missing'
      })
      const worker = await measure(() => client.readCursorProfile(stateDbPath('worker')))
      expect(worker.value).toMatchObject({ status: 'ok', profile: { accessToken: TOKEN } })

      const inline = await measure(async () => readTokenInline(stateDbPath('inline')))
      expect(inline.value).toBe(TOKEN)

      const report = `${describeArm('worker', worker)}; ${describeArm('inline', inline)}`
      expect(worker.wallMs, report).toBeGreaterThan(inline.activeMs / 4)
      expect(worker.activeMs, report).toBeLessThan(inline.activeMs / 5)
      expect(worker.maxTimerLatenessMs, report).toBeLessThan(inline.maxTimerLatenessMs / 2)
    } finally {
      client.dispose()
    }
  }, 120_000)
})
