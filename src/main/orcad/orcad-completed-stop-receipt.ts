/** Durable outcomes of a managed stop, in the data root beside the instance lock. */
import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  ORCAD_STOP_RECEIPTS_DIRNAME,
  OrcadCompletedStopReceiptSchema,
  OrcadManagedStopRequestSchema,
  OrcadDaemonRetirementRecordSchema,
  type OrcadCompletedStopReceipt,
  type OrcadDaemonRetirementRecord,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'

const RECEIPT_MAX_BYTES = 64 * 1024

export type ReceiptKind = 'completed' | 'retirement' | 'decision'

export function orcadStopReceiptPath(request: OrcadManagedStopRequest, kind: ReceiptKind): string {
  const { transactionId, instance } = OrcadManagedStopRequestSchema.parse(request)
  const suffix = kind === 'completed' ? '' : `.${kind}`
  return join(
    dirname(instance.lockPath),
    ORCAD_STOP_RECEIPTS_DIRNAME,
    `${transactionId}${suffix}.json`
  )
}

/** `null` when absent; a receipt for a different request throws rather than reading as absent. */
export function readOrcadStopReceipt<T extends { request: OrcadManagedStopRequest }>(
  request: OrcadManagedStopRequest,
  kind: ReceiptKind,
  schema: z.ZodType<T>
): T | null {
  const path = orcadStopReceiptPath(request, kind)
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('orcad_stop_receipt_unverifiable')
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  const receipt = schema.parse(
    JSON.parse(readNodeFileSyncWithinLimit(path, RECEIPT_MAX_BYTES).buffer.toString('utf8'))
  )
  const expected = OrcadManagedStopRequestSchema.parse(request)
  if (JSON.stringify(receipt.request) !== JSON.stringify(expected)) {
    throw new Error('orcad_stop_receipt_mismatch')
  }
  return receipt
}

function writeReceipt(request: OrcadManagedStopRequest, kind: ReceiptKind, receipt: unknown): void {
  if (!writeDurableSecureJsonFile(orcadStopReceiptPath(request, kind), receipt)) {
    throw new Error('orcad_stop_receipt_permissions_unconfirmed')
  }
}

export function readOrcadCompletedStopReceipt(
  request: OrcadManagedStopRequest
): OrcadCompletedStopReceipt | null {
  return readOrcadStopReceipt(request, 'completed', OrcadCompletedStopReceiptSchema)
}

/**
 * Called only after exit is proven; rewriting an existing receipt re-runs its fsync. A retiring
 * request whose orcad left no retirement record reports `unverifiable`, never `retired`.
 */
export function persistOrcadCompletedStopReceipt(
  request: OrcadManagedStopRequest,
  exitedAt: Date
): OrcadCompletedStopReceipt {
  const parsed = OrcadManagedStopRequestSchema.parse(request)
  const retirement = parsed.retireIdleDaemon
    ? (readOrcadDaemonRetirementRecord(parsed)?.retirement ?? 'unverifiable')
    : undefined
  const receipt = readOrcadCompletedStopReceipt(parsed) ?? {
    schemaVersion: 1 as const,
    kind: 'orcad_managed_stop_completed' as const,
    request: parsed,
    exitedAt: exitedAt.toISOString(),
    ...(retirement ? { retirement } : {})
  }
  writeReceipt(parsed, 'completed', receipt)
  return receipt
}

export function readOrcadDaemonRetirementRecord(
  request: OrcadManagedStopRequest
): OrcadDaemonRetirementRecord | null {
  return readOrcadStopReceipt(request, 'retirement', OrcadDaemonRetirementRecordSchema)
}

export function persistOrcadDaemonRetirementRecord(
  request: OrcadManagedStopRequest,
  outcome: Pick<OrcadDaemonRetirementRecord, 'retirement' | 'liveSessions' | 'reason'>
): void {
  writeReceipt(request, 'retirement', {
    schemaVersion: 1,
    kind: 'orcad_managed_stop_retirement',
    request: OrcadManagedStopRequestSchema.parse(request),
    ...outcome
  })
}
