import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeWithAutomationOperations } from '../orca-runtime-automation-operations'
import {
  createOrchestrationRetryRequestId,
  ORCHESTRATION_RETRY_WINDOW_MS
} from '../../../shared/orchestration-retry-request-id'
import { OrchestrationDb } from './db'
import {
  retireMutationReceipts,
  startMutationReceiptMaintenance,
  RETIRE_MUTATION_RECEIPT_BATCH_SQL
} from './db/mutation-receipts/mutation-receipt-maintenance'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const EXPIRED = NOW - ORCHESTRATION_RETRY_WINDOW_MS - 1

function seed(
  store: OrchestrationDb,
  count: number,
  time: number | null,
  state = 'pending'
): string[] {
  const ids: string[] = []
  const insert = store.db.prepare(`INSERT INTO mutation_receipts
    (caller_fingerprint, request_id, method, payload_hash, state, retain_from_ms, updated_at)
    VALUES ('caller', ?, 'orchestration.send', 'hash', ?, ?, '2000-01-01 00:00:00')`)
  for (let i = 0; i < count; i++) {
    const id = createOrchestrationRetryRequestId(time ?? 0)
    ids.push(id)
    insert.run(id, state, time)
  }
  return ids
}

function count(store: OrchestrationDb): number {
  return Number(store.db.prepare('SELECT count(*) AS count FROM mutation_receipts').get()?.count)
}

function fresh(store: OrchestrationDb) {
  return store.beginMutationReceipt({
    callerFingerprint: 'fresh',
    requestId: createOrchestrationRetryRequestId(NOW),
    method: 'orchestration.send',
    payloadHash: 'hash'
  })
}

describe('mutation receipt retirement', () => {
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

  it('retires both states by retention time, preserves the boundary, live ids and legacy inserts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    seed(db, 3, EXPIRED)
    seed(db, 3, EXPIRED, 'completed')
    const boundary = seed(db, 1, EXPIRED + 1)
    const future = seed(db, 1, NOW + ORCHESTRATION_RETRY_WINDOW_MS)
    const legacy = seed(db, 1, null, 'completed')
    db.db.exec(`INSERT INTO mutation_receipts
      (caller_fingerprint, request_id, method, payload_hash, state, updated_at)
      VALUES ('caller', '11111111-2222-4333-8444-555555555555', 'orchestration.send', 'hash', 'pending', '2000-01-01')`)
    await retireMutationReceipts(db.db)
    expect(count(db)).toBe(4)
    for (const id of [...boundary, ...future, ...legacy, '11111111-2222-4333-8444-555555555555']) {
      expect(db.getMutationReceipt('caller', id)).toBeDefined()
    }
    expect(db.getMutationReceipt('caller', '11111111-2222-4333-8444-555555555555')).toMatchObject({
      retain_from_ms: null
    })
  })

  it('keeps the durable boundary across clock rollback and database reopen', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    directory = mkdtempSync(join(tmpdir(), 'orca-receipt-retirement-'))
    const path = join(directory, 'o.db')
    db = new OrchestrationDb(path)
    const [id] = seed(db, 1, EXPIRED)
    await retireMutationReceipts(db.db)
    db.close()
    clock.mockReturnValue(NOW - ORCHESTRATION_RETRY_WINDOW_MS)
    db = new OrchestrationDb(path)
    await retireMutationReceipts(db.db)
    expect(
      db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
    ).toEqual({ retired_before_ms: EXPIRED })
    expect(() =>
      db?.beginMutationReceipt({
        callerFingerprint: 'caller',
        requestId: id ?? '',
        requestRetry: true,
        method: 'orchestration.send',
        payloadHash: 'hash'
      })
    ).toThrowError(expect.objectContaining({ code: 'operation_unknown' }))
    expect(count(db)).toBe(0)
  })

  it('does not advance an empty database boundary during a forward clock excursion', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW + 2 * ORCHESTRATION_RETRY_WINDOW_MS)
    db = new OrchestrationDb(':memory:')
    await retireMutationReceipts(db.db)
    expect(
      db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
    ).toEqual({ retired_before_ms: 0 })
    clock.mockReturnValue(NOW)
    expect(fresh(db)).toMatchObject({ disposition: 'started' })
  })

  it('advances only to the maximum deleted retention key and keeps it across rollback', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    seed(db, 1, EXPIRED - 1000)
    seed(db, 1, EXPIRED)
    seed(db, 1, NOW)
    await retireMutationReceipts(db.db)
    expect(
      db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
    ).toEqual({ retired_before_ms: EXPIRED })
    clock.mockReturnValue(NOW - 2 * ORCHESTRATION_RETRY_WINDOW_MS)
    await retireMutationReceipts(db.db)
    expect(
      db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
    ).toEqual({ retired_before_ms: EXPIRED })
    expect(fresh(db)).toMatchObject({ disposition: 'started' })
  })

  it('retains an in-flight edge request for 30 days from host insertion', async () => {
    db = new OrchestrationDb(':memory:')
    const beforeInsert = Date.now()
    const input = {
      callerFingerprint: 'caller',
      requestId: createOrchestrationRetryRequestId(
        beforeInsert - ORCHESTRATION_RETRY_WINDOW_MS + 1
      ),
      method: 'orchestration.send',
      payloadHash: 'hash',
      requestRetry: true as const
    }
    const row = db.beginMutationReceipt(input).row
    expect(row.retain_from_ms).toBeGreaterThanOrEqual(beforeInsert)
    vi.spyOn(Date, 'now').mockReturnValue(beforeInsert + 60_000)
    await retireMutationReceipts(db.db)
    expect(db.completeMutationReceipt({ ...input, receipt: '{}' })).toMatchObject({
      state: 'completed'
    })
  })

  it('recreates a missing boundary singleton without advancing it when no rows retire', async () => {
    db = new OrchestrationDb(':memory:')
    db.db.exec('DELETE FROM mutation_receipt_retirement')
    await retireMutationReceipts(db.db)
    expect(
      db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
    ).toEqual({ retired_before_ms: 0 })
  })

  it('uses the retention-time index without scanning or sorting receipts', () => {
    db = new OrchestrationDb(':memory:')
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${RETIRE_MUTATION_RECEIPT_BATCH_SQL}`)
      .all(NOW, 256)
      .map((row) => String(row.detail))
      .join('\n')
    expect(plan).toContain('idx_mutation_receipts_retain_from')
    expect(plan).not.toContain('USE TEMP B-TREE')
    expect(plan).not.toMatch(/SCAN mutation_receipts(?:\n|$)/)
  })

  it('yields after bounded batches and stops a running job between batches', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    seed(db, 600, EXPIRED)
    let stopped = false
    const pruning = retireMutationReceipts(db.db, () => stopped)
    expect(count(db)).toBe(600 - 256)
    stopped = true
    await pruning
    expect(count(db)).toBe(600 - 256)
    await retireMutationReceipts(db.db)
    expect(count(db)).toBe(0)
  })

  it('does not wait for another writer and restores busy_timeout', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    directory = mkdtempSync(join(tmpdir(), 'orca-receipt-lock-'))
    const path = join(directory, 'o.db')
    db = new OrchestrationDb(path)
    seed(db, 1, EXPIRED)
    other = new Database(path)
    other.exec('BEGIN IMMEDIATE')
    try {
      await expect(retireMutationReceipts(db.db)).rejects.toThrow(/busy|locked/i)
      expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    } finally {
      other.exec('ROLLBACK')
    }
    expect(fresh(db)).toMatchObject({ disposition: 'started' })
    await retireMutationReceipts(db.db)
    expect(count(db)).toBe(1)
  })

  it.each(['boundary', 'delete'])(
    'logs a failed %s write while fresh admission succeeds, retries, and stops',
    async (failure) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
      })
      vi.setSystemTime(NOW)
      db = new OrchestrationDb(':memory:')
      seed(db, 1, EXPIRED)
      const target =
        failure === 'boundary'
          ? 'UPDATE ON mutation_receipt_retirement'
          : 'DELETE ON mutation_receipts'
      db.db.exec(
        `CREATE TRIGGER refuse_cleanup BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`
      )
      const onError = vi.fn()
      const job = startMutationReceiptMaintenance(db.db, {
        initialDelayMs: 1000,
        intervalMs: 10_000,
        onError
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(onError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'cleanup unavailable' })
      )
      expect(count(db)).toBe(1)
      expect(
        db.db.prepare('SELECT retired_before_ms FROM mutation_receipt_retirement').get()
      ).toEqual({ retired_before_ms: 0 })
      expect(fresh(db)).toMatchObject({ disposition: 'started' })
      db.db.exec('DROP TRIGGER refuse_cleanup')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(count(db)).toBe(1)
      expect(onError).toHaveBeenCalledOnce()
      seed(db, 1, EXPIRED)
      job.stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(count(db)).toBe(2)
    }
  )

  it('starts for the runtime-opened database and stops when replaced by an injected one', () => {
    vi.useFakeTimers()
    directory = mkdtempSync(join(tmpdir(), 'orca-receipt-runtime-'))
    const path = join(directory, 'o.db')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prototype probe supplies every field read by these database lifecycle methods.
    const runtime = Object.assign(Object.create(OrcaRuntimeWithAutomationOperations.prototype), {
      _orchestrationDb: null,
      orchestrationDbPath: () => path,
      ensureOrchestrationFederationRelay: vi.fn(),
      scheduleRestoredMessageRepoints: vi.fn(),
      orchestrationFederation: { resetForDatabaseChange: vi.fn() },
      mailPointerRepointScheduler: { clear: vi.fn() }
    }) as OrcaRuntimeWithAutomationOperations
    const opened = runtime.getOrchestrationDb()
    db = opened
    expect(vi.getTimerCount()).toBe(2)
    const injected = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(injected)
    expect(vi.getTimerCount()).toBe(0)
    opened.close()
    db = injected
  })

  it('starts maintenance explicitly and stops it before closing the database', () => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
    expect(vi.getTimerCount()).toBe(0)
    db.startReceiptMaintenance()
    expect(vi.getTimerCount()).toBe(2)
    db.close()
    db = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})
