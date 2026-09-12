import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORCAD_CANCELED_STOPS_DIRNAME,
  OrcadCanceledStopReceiptSchema,
  orcadCanceledStopReceiptFilename
} from '../../shared/orcad-managed-stop-cancellation'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { RELAY_REMOTE_DIR } from '../ssh/relay-protocol'

function receiptPath(home: string, transactionId: string): string {
  return join(
    home,
    RELAY_REMOTE_DIR,
    ORCAD_CANCELED_STOPS_DIRNAME,
    orcadCanceledStopReceiptFilename(transactionId)
  )
}

function receiptExists(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new Error('orcad_canceled_stop_receipt_unverifiable')
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export function assertOrcadStopNotCanceled(home: string, transactionId: string): void {
  // Even malformed cancellation evidence must prevent delayed destructive requests.
  if (receiptExists(receiptPath(home, transactionId))) {
    throw new Error('orcad_managed_stop_canceled')
  }
}

export function readOrcadCanceledStopReceipt(
  home: string,
  request: OrcadManagedStopRequest
): boolean {
  const expected = OrcadManagedStopRequestSchema.parse(request)
  const path = receiptPath(home, expected.authority.transactionId)
  if (!receiptExists(path)) {
    return false
  }
  const receipt = OrcadCanceledStopReceiptSchema.parse(
    JSON.parse(readNodeFileSyncWithinLimit(path, 64 * 1024).buffer.toString('utf8'))
  )
  if (JSON.stringify(receipt.request) !== JSON.stringify(expected)) {
    throw new Error('orcad_canceled_stop_receipt_mismatch')
  }
  return true
}

// The service must hold stop exclusion and validate native reopening before invoking this writer.
export function persistOrcadCanceledStopReceipt(
  home: string,
  request: OrcadManagedStopRequest
): void {
  const parsed = OrcadManagedStopRequestSchema.parse(request)
  readOrcadCanceledStopReceipt(home, parsed)
  if (
    !writeDurableSecureJsonFile(receiptPath(home, parsed.authority.transactionId), {
      schemaVersion: 1,
      kind: 'orcad_managed_stop_canceled',
      request: parsed
    })
  ) {
    throw new Error('orcad_canceled_stop_receipt_permissions_unconfirmed')
  }
}
