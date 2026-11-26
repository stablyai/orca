import { randomBytes } from 'node:crypto'
import type { MutationReceiptRow } from '../orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from './mutation-receipt-capacity'
import type { OrchestrationDb } from '../orchestration-db'
import { MUTATION_RECEIPT_COLUMN_LIST } from '../row-column-lists'
import { retryNotReplayable } from './replay-only-request'

export function getOrCreateLocalMutationCallerFingerprint(this: OrchestrationDb): string {
  if (this.localMutationCallerFingerprint) {
    return this.localMutationCallerFingerprint
  }
  const transport = 'local_authenticated_transport'
  const existing = this.db
    .prepare('SELECT caller_fingerprint FROM mutation_caller_identities WHERE transport = ?')
    .get(transport) as { caller_fingerprint: string } | undefined
  if (existing) {
    this.localMutationCallerFingerprint = existing.caller_fingerprint
    return this.localMutationCallerFingerprint
  }
  this.db
    .prepare(
      `INSERT OR IGNORE INTO mutation_caller_identities (transport, caller_fingerprint)
       VALUES (?, ?)`
    )
    .run(transport, randomBytes(32).toString('hex'))
  const created = this.db
    .prepare('SELECT caller_fingerprint FROM mutation_caller_identities WHERE transport = ?')
    .get(transport) as { caller_fingerprint: string } | undefined
  if (!created) {
    throw new Error('Failed to create the local orchestration mutation caller identity.')
  }
  this.localMutationCallerFingerprint = created.caller_fingerprint
  return this.localMutationCallerFingerprint
}

export function beginMutationReceipt(
  this: OrchestrationDb,
  params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
    pendingReceipt?: string
  },
  /** The caller may already have committed this key; never admit it as new work. */
  { requireExisting = false }: { requireExisting?: boolean } = {}
):
  | { disposition: 'started'; row: MutationReceiptRow }
  | { disposition: 'pending'; row: MutationReceiptRow }
  | { disposition: 'completed'; row: MutationReceiptRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = this.getMutationReceipt(params.callerFingerprint, params.requestId)
    if (existing) {
      if (existing.method !== params.method || existing.payload_hash !== params.payloadHash) {
        throw new OrchestrationError(
          'request_mismatch',
          `Mutation request ${params.requestId} was already used with different input.`
        )
      }
      this.db.exec('COMMIT')
      return { disposition: existing.state, row: existing }
    }
    if (requireExisting) {
      throw retryNotReplayable(params.requestId, 'receipt_absent')
    }
    ensureMutationReceiptCapacity(this.db)
    this.db
      .prepare(
        `INSERT INTO mutation_receipts (
           caller_fingerprint, request_id, method, payload_hash, state, receipt
         ) VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        params.callerFingerprint,
        params.requestId,
        params.method,
        params.payloadHash,
        params.pendingReceipt ?? null
      )
    const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
    this.db.exec('COMMIT')
    return { disposition: 'started', row: row as MutationReceiptRow }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function completeMutationReceipt(
  this: OrchestrationDb,
  params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }
): MutationReceiptRow {
  const result = this.db
    .prepare(
      `UPDATE mutation_receipts
       SET state = 'completed', receipt = ?, updated_at = datetime('now')
       WHERE caller_fingerprint = ? AND request_id = ? AND method = ?
         AND payload_hash = ?`
    )
    .run(
      params.receipt,
      params.callerFingerprint,
      params.requestId,
      params.method,
      params.payloadHash
    )
  const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
  if (result.changes !== 1 || !row) {
    throw new OrchestrationError(
      'request_mismatch',
      `Mutation request ${params.requestId} no longer matches its pending operation.`
    )
  }
  return row
}

export function checkpointPendingMutationReceipt(
  this: OrchestrationDb,
  params: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }
): MutationReceiptRow {
  const result = this.db
    .prepare(
      `UPDATE mutation_receipts
       SET receipt = ?, updated_at = datetime('now')
       WHERE caller_fingerprint = ? AND request_id = ? AND method = ?
         AND payload_hash = ? AND state = 'pending'`
    )
    .run(
      params.receipt,
      params.callerFingerprint,
      params.requestId,
      params.method,
      params.payloadHash
    )
  const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
  if (result.changes !== 1 || !row) {
    throw new OrchestrationError(
      'request_mismatch',
      `Mutation request ${params.requestId} no longer matches its pending operation.`
    )
  }
  return row
}

export function admitPreparedMutationReceipts(
  this: OrchestrationDb,
  callerFingerprint: string,
  requestIds: readonly string[],
  pendingReceipt: string
): void {
  this.db
    .prepare(
      `UPDATE mutation_receipts SET receipt = NULL
       WHERE caller_fingerprint = ? AND request_id IN (SELECT value FROM json_each(?))
         AND state = 'pending' AND receipt = ?`
    )
    .run(callerFingerprint, JSON.stringify(requestIds), pendingReceipt)
}

export function discardPendingMutationReceipt(
  this: OrchestrationDb,
  callerFingerprint: string,
  requestId: string
): void {
  this.db
    .prepare(
      `DELETE FROM mutation_receipts
       WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
    )
    .run(callerFingerprint, requestId)
}

export function countPendingMutationReceipts(
  this: OrchestrationDb,
  callerFingerprints: readonly string[]
): number {
  const count = this.db
    .prepare(
      `SELECT COUNT(*) AS count FROM mutation_receipts
       WHERE caller_fingerprint IN (SELECT value FROM json_each(?)) AND state = 'pending'`
    )
    .get(JSON.stringify(callerFingerprints))?.count
  return Number(count ?? 0)
}

/** Completes these callers' pending rows with `receipt`, for operations no running work owns. */
export function settlePendingMutationReceipts(
  this: OrchestrationDb,
  callerFingerprints: readonly string[],
  receipt: string,
  retryableReceipt?: string
): void {
  const fingerprints = JSON.stringify(callerFingerprints)
  const settle = `UPDATE mutation_receipts
    SET state = 'completed', receipt = CASE WHEN receipt = ? THEN receipt ELSE ? END,
        updated_at = datetime('now')
    WHERE caller_fingerprint IN (SELECT value FROM json_each(?)) AND state = 'pending'`
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const settled = this.db
      .prepare(`${settle} RETURNING caller_fingerprint, request_id, receipt`)
      .all(retryableReceipt ?? null, receipt, fingerprints)
    if (settled.some((row) => row.receipt === retryableReceipt)) {
      const discard = this.db.prepare(
        'DELETE FROM mutation_receipts WHERE caller_fingerprint = ? AND request_id = ?'
      )
      for (const row of settled) {
        if (row.receipt === retryableReceipt) {
          discard.run(String(row.caller_fingerprint), String(row.request_id))
        }
      }
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getMutationReceipt(
  this: OrchestrationDb,
  callerFingerprint: string,
  requestId: string
): MutationReceiptRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type, and a missing one fails compilation.
  return this.db
    .prepare(
      `SELECT ${MUTATION_RECEIPT_COLUMN_LIST} FROM mutation_receipts
       WHERE caller_fingerprint = ? AND request_id = ?`
    )
    .get(callerFingerprint, requestId) as MutationReceiptRow | undefined
}

export type MutationReceiptStoreMethods = {
  getOrCreateLocalMutationCallerFingerprint: typeof getOrCreateLocalMutationCallerFingerprint
  beginMutationReceipt: typeof beginMutationReceipt
  completeMutationReceipt: typeof completeMutationReceipt
  checkpointPendingMutationReceipt: typeof checkpointPendingMutationReceipt
  admitPreparedMutationReceipts: typeof admitPreparedMutationReceipts
  discardPendingMutationReceipt: typeof discardPendingMutationReceipt
  countPendingMutationReceipts: typeof countPendingMutationReceipts
  settlePendingMutationReceipts: typeof settlePendingMutationReceipts
  getMutationReceipt: typeof getMutationReceipt
}

export function attachMutationReceiptStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getOrCreateLocalMutationCallerFingerprint,
    beginMutationReceipt,
    completeMutationReceipt,
    checkpointPendingMutationReceipt,
    admitPreparedMutationReceipts,
    discardPendingMutationReceipt,
    countPendingMutationReceipts,
    settlePendingMutationReceipts,
    getMutationReceipt
  })
}
