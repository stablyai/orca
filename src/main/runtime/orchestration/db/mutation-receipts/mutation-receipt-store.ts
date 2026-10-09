import { randomBytes } from 'node:crypto'
import type { MutationReceiptRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { insertMutationReceiptIfAbsent } from './mutation-receipt-insert'
import type { OrchestrationDb } from '../orchestration-db'

// ── Durable mutation receipts ──

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
    requestRetry?: true
  }
):
  | { disposition: 'started'; row: MutationReceiptRow }
  | { disposition: 'pending'; row: MutationReceiptRow }
  | { disposition: 'completed'; row: MutationReceiptRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const inserted = insertMutationReceiptIfAbsent(this, params)
    if (!inserted.inserted) {
      if (inserted.reason === 'conflict') {
        throw new OrchestrationError(
          'request_mismatch',
          `Mutation request ${params.requestId} was already used with different input.`
        )
      }
      this.db.exec('COMMIT')
      return { disposition: inserted.existing.state, row: inserted.existing }
    }
    const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
    if (!row) {
      throw new Error('Inserted mutation receipt is missing')
    }
    this.db.exec('COMMIT')
    return { disposition: 'started', row }
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

export function getMutationReceipt(
  this: OrchestrationDb,
  callerFingerprint: string,
  requestId: string
): MutationReceiptRow | undefined {
  return this.db
    .prepare(
      `SELECT * FROM mutation_receipts
       WHERE caller_fingerprint = ? AND request_id = ?`
    )
    .get(callerFingerprint, requestId) as MutationReceiptRow | undefined
}

export type MutationReceiptStoreMethods = {
  getOrCreateLocalMutationCallerFingerprint: typeof getOrCreateLocalMutationCallerFingerprint
  beginMutationReceipt: typeof beginMutationReceipt
  completeMutationReceipt: typeof completeMutationReceipt
  checkpointPendingMutationReceipt: typeof checkpointPendingMutationReceipt
  discardPendingMutationReceipt: typeof discardPendingMutationReceipt
  getMutationReceipt: typeof getMutationReceipt
}

export function attachMutationReceiptStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getOrCreateLocalMutationCallerFingerprint,
    beginMutationReceipt,
    completeMutationReceipt,
    checkpointPendingMutationReceipt,
    discardPendingMutationReceipt,
    getMutationReceipt
  })
}
