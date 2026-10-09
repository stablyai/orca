import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { ORCHESTRATION_RETRY_WINDOW_MS } from '../../../shared/orchestration-retry-request-id'
import { OrchestrationDb } from './db'
import { retireMutationReceipts } from './db/mutation-receipts/mutation-receipt-maintenance'

const LEGACY_UUID = '11111111-2222-4333-8444-555555555555'
const cases = [
  ['orchestration.federationAck', 'relay_ack_dispatch_1', true],
  ['orchestration.federationImport', 'relay_import_dispatch_1', true],
  ['orchestration.federationAck', LEGACY_UUID, false],
  ['orchestration.federationImport', LEGACY_UUID, false],
  ['orchestration.send', 'relay_ack_dispatch_1', false],
  ['orchestration.federationAck', 'relay_import_dispatch_1', false]
] as const

describe('watermark receipt retention', () => {
  let db: OrchestrationDb | undefined
  let directory: string | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(cases)(
    'records host age for %s %s only when watermark-idempotent',
    async (method, requestId, timed) => {
      db = new OrchestrationDb(':memory:')
      const row = db.beginMutationReceipt({
        callerFingerprint: 'caller',
        method,
        requestId,
        payloadHash: 'hash'
      }).row
      expect(row.retain_from_ms).toEqual(timed ? expect.any(Number) : null)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * ORCHESTRATION_RETRY_WINDOW_MS)
      await retireMutationReceipts(db.db)
      expect(db.getMutationReceipt('caller', requestId) === undefined).toBe(timed)
      // These legacy ids remain safe to re-admit because sequence watermarks own the effects.
      if (timed) {
        expect(
          db.beginMutationReceipt({
            callerFingerprint: 'caller',
            method,
            requestId,
            payloadHash: 'hash',
            requestRetry: true
          })
        ).toMatchObject({ disposition: 'started' })
      }
    }
  )

  it('backfills only matching old relay methods from their host-created time during v44', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-relay-retention-'))
    const path = join(directory, 'o.db')
    db = new OrchestrationDb(path)
    db.close()
    db = undefined
    const old = new Database(path)
    old.exec(`DROP INDEX idx_mutation_receipts_retain_from;
      ALTER TABLE mutation_receipts DROP COLUMN retain_from_ms;
      DROP TABLE mutation_receipt_retirement; PRAGMA user_version = 43;`)
    const insert = old.prepare(`INSERT INTO mutation_receipts
      (caller_fingerprint, request_id, method, payload_hash, state, created_at)
      VALUES (?, ?, ?, 'hash', 'completed', '2000-01-01 00:00:00')`)
    cases.forEach(([method, requestId], index) => insert.run(String(index), requestId, method))
    old.close()
    db = new OrchestrationDb(path)
    const store = db
    cases.forEach(([, requestId, timed], index) => {
      expect(store.getMutationReceipt(String(index), requestId)?.retain_from_ms).toBe(
        timed ? Date.parse('2000-01-01T00:00:00Z') : null
      )
    })
    await retireMutationReceipts(db.db)
    cases.forEach(([, requestId, timed], index) => {
      expect(store.getMutationReceipt(String(index), requestId) === undefined).toBe(timed)
    })
  })
})
