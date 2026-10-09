import type { CommandReceiptInsert } from '../../../../../shared/command-receipt-insert'
import { orchestrationRetryRequestIssuedAtMs } from '../../../../../shared/orchestration-retry-request-id'
import { OrchestrationError } from '../../orchestration-error'
import type { MutationReceiptRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { isWatermarkMutationReceipt } from './mutation-receipt-retention'

export type MutationReceiptInput = {
  callerFingerprint: string
  requestId: string
  requestRetry?: true
  method: string
  payloadHash: string
  receipt?: string
}

export type MutationReceiptInsert = CommandReceiptInsert<MutationReceiptRow>

export function insertMutationReceiptIfAbsent(
  store: OrchestrationDb,
  params: MutationReceiptInput
): MutationReceiptInsert {
  if (!store.db.isTransaction) {
    throw new Error('A mutation receipt must be written inside an open transaction')
  }
  const existing = store.getMutationReceipt(params.callerFingerprint, params.requestId)
  if (existing) {
    return {
      inserted: false,
      reason:
        existing.method === params.method && existing.payload_hash === params.payloadHash
          ? 'duplicate'
          : 'conflict',
      existing
    }
  }
  const issuedAtMs = orchestrationRetryRequestIssuedAtMs(params.requestId)
  if (params.requestRetry === true && issuedAtMs !== null) {
    let boundary: unknown
    try {
      boundary = store.db
        .prepare('SELECT retired_before_ms FROM mutation_receipt_retirement WHERE singleton = 1')
        .get()?.retired_before_ms
    } catch {
      // Missing retirement proof makes only an absent declared retry ambiguous.
    }
    if (
      typeof boundary !== 'number' ||
      !Number.isSafeInteger(boundary) ||
      boundary < 0 ||
      issuedAtMs <= boundary
    ) {
      throw new OrchestrationError(
        'operation_unknown',
        `Orca no longer keeps a record of request ${params.requestId} (records are kept for 30 days), so it can't tell whether it already ran. Check the work it would have created; to do it again, run the command without --retry-request.`,
        { requestId: params.requestId, reason: 'retry_record_retired' }
      )
    }
  }
  const retentionFloor =
    issuedAtMs ?? (isWatermarkMutationReceipt(params.method, params.requestId) ? 0 : null)
  store.db
    .prepare(`INSERT INTO mutation_receipts (
      caller_fingerprint, request_id, method, payload_hash, state, receipt, retain_from_ms
    ) VALUES (?, ?, ?, ?, 'pending', ?, CASE
      WHEN ? IS NOT NULL THEN max(?, CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER))
      ELSE NULL END)`)
    .run(
      params.callerFingerprint,
      params.requestId,
      params.method,
      params.payloadHash,
      params.receipt ?? null,
      retentionFloor,
      retentionFloor
    )
  return { inserted: true }
}
