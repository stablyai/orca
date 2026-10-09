import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeWithAutomationOperations } from '../orca-runtime-automation-operations'
import { OrchestrationDb } from './db'
import {
  pruneMutationReceipts,
  startMutationReceiptMaintenance
} from './mutation-receipt-maintenance'

const fresh = {
  callerFingerprint: 'user',
  requestId: 'fresh',
  method: 'terminal.send',
  payloadHash: 'payload'
}

/** Rows `prefix_00001..count`; `ageSql` sees N as `value`, so SECONDS_AGO makes higher N older. */
function seed(
  db: OrchestrationDb,
  options: {
    prefix: string
    count: number
    state: 'pending' | 'completed'
    ageSql: string
  }
): void {
  db.db
    .prepare(
      `WITH RECURSIVE numbers(value) AS (
         VALUES (1) UNION ALL SELECT value + 1 FROM numbers WHERE value < ?
       )
       INSERT INTO mutation_receipts (
         caller_fingerprint, request_id, method, payload_hash, state, updated_at
       ) SELECT 'other', printf('%s_%05d', ?, value), 'terminal.send', 'hash', ?, ${options.ageSql}
       FROM numbers`
    )
    .run(options.count, options.prefix, options.state)
}

const LONG_EXPIRED = "'2000-01-01 00:00:00'"
const SECONDS_AGO = "datetime('now', printf('-%d seconds', value))"

function count(db: OrchestrationDb, where: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM mutation_receipts WHERE ${where}`).get()
  return Number(row?.count)
}

describe('mutation receipt maintenance', () => {
  let db: OrchestrationDb | undefined
  let other: Database.Database | undefined
  let directory: string | undefined

  afterEach(() => {
    other?.close()
    other = undefined
    db?.close()
    db = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('opening the database starts no timers', () => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires pending and completed receipts after 30 days and keeps live ones', async () => {
    db = new OrchestrationDb(':memory:')
    seed(db, { prefix: 'stranded', count: 3, state: 'pending', ageSql: LONG_EXPIRED })
    seed(db, { prefix: 'old', count: 3, state: 'completed', ageSql: LONG_EXPIRED })
    seed(db, { prefix: 'recent', count: 3, state: 'completed', ageSql: SECONDS_AGO })
    db.beginMutationReceipt(fresh)

    await pruneMutationReceipts(db.db)

    expect(count(db, "request_id LIKE 'stranded_%' OR request_id LIKE 'old_%'")).toBe(0)
    expect(count(db, "request_id LIKE 'recent_%'")).toBe(3)
    expect(db.getMutationReceipt('user', 'fresh')).toMatchObject({ state: 'pending' })
  })

  it('trims completed receipts beyond the newest 10,000 oldest-first, never pending ones', async () => {
    db = new OrchestrationDb(':memory:')
    seed(db, { prefix: 'done', count: 10_300, state: 'completed', ageSql: SECONDS_AGO })
    seed(db, { prefix: 'inflight', count: 400, state: 'pending', ageSql: SECONDS_AGO })

    await pruneMutationReceipts(db.db)

    expect(count(db, "state = 'completed'")).toBe(10_000)
    expect(count(db, "state = 'pending'")).toBe(400)
    expect(db.getMutationReceipt('other', 'done_10000')).toBeDefined()
    expect(db.getMutationReceipt('other', 'done_10001')).toBeUndefined()
    expect(db.getMutationReceipt('other', 'done_10300')).toBeUndefined()

    await pruneMutationReceipts(db.db)
    expect(count(db, "state = 'completed'")).toBe(10_000)
  })

  it('drains a backlog in batches and stops between batches', async () => {
    db = new OrchestrationDb(':memory:')
    seed(db, { prefix: 'old', count: 600, state: 'completed', ageSql: LONG_EXPIRED })
    let checks = 0

    await pruneMutationReceipts(db.db, () => checks++ > 0)
    expect(count(db, "request_id LIKE 'old_%'")).toBe(600 - 256)

    await pruneMutationReceipts(db.db)
    expect(count(db, "request_id LIKE 'old_%'")).toBe(0)
  })

  it('yields to another SQLite writer and restores the normal write timeout', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-receipt-maintenance-'))
    const path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    seed(db, { prefix: 'old', count: 1, state: 'completed', ageSql: LONG_EXPIRED })
    other = new Database(path)
    other.exec('BEGIN IMMEDIATE')
    try {
      const started = Date.now()
      await expect(pruneMutationReceipts(db.db)).rejects.toThrow(/locked|busy/i)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    } finally {
      other.exec('ROLLBACK')
    }

    await pruneMutationReceipts(db.db)
    expect(db.getMutationReceipt('other', 'old_00001')).toBeUndefined()
  })

  it('reports a failed run, never refuses user writes, retries on the next run, and stops', async () => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
    seed(db, { prefix: 'old', count: 1, state: 'completed', ageSql: LONG_EXPIRED })
    db.db.exec(`CREATE TRIGGER refuse_cleanup BEFORE DELETE ON mutation_receipts
      BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    const onError = vi.fn()
    const job = startMutationReceiptMaintenance(db.db, {
      initialDelayMs: 1_000,
      intervalMs: 10_000,
      onError
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cleanup unavailable' })
    )
    expect(db.beginMutationReceipt(fresh)).toMatchObject({ disposition: 'started' })
    expect(db.getMutationReceipt('other', 'old_00001')).toBeDefined()

    db.db.exec('DROP TRIGGER refuse_cleanup')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(db.getMutationReceipt('other', 'old_00001')).toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()

    seed(db, { prefix: 'later', count: 1, state: 'completed', ageSql: LONG_EXPIRED })
    job.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(db.getMutationReceipt('other', 'later_00001')).toBeDefined()
  })

  it('runs for the database the runtime opens and stops when another one is injected', () => {
    vi.useFakeTimers()
    const dbPath = join(mkdtempSync(join(tmpdir(), 'orca-receipt-maintenance-runtime-')), 'o.db')
    directory = dirname(dbPath)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a prototype-only probe; the stubs below are every field these two methods read.
    const runtime = Object.assign(Object.create(OrcaRuntimeWithAutomationOperations.prototype), {
      _orchestrationDb: null,
      orchestrationDbPath: () => dbPath,
      ensureOrchestrationFederationRelay: vi.fn(),
      scheduleRestoredMessageRepoints: vi.fn(),
      orchestrationFederation: { resetForDatabaseChange: vi.fn() },
      mailPointerRepointScheduler: { clear: vi.fn() }
    }) as OrcaRuntimeWithAutomationOperations

    const opened = runtime.getOrchestrationDb()
    expect(vi.getTimerCount()).toBe(2)

    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    expect(vi.getTimerCount()).toBe(0)
    opened.close()
  })
})
