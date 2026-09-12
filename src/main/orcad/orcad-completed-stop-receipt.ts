import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { OrcadManagedStopRequest } from '../../shared/orcad-managed-stop-request'
import { RELAY_REMOTE_DIR } from '../ssh/relay-protocol'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  withOrcadDecommissionPhase
} from '../ssh/orcad-activation-transaction'
import {
  ORCAD_COMPLETED_STOP_RECEIPT_FILENAME,
  parseOrcadCompletedStopReceipt
} from '../ssh/orcad-completed-stop-receipt'
import { validateOrcadDecommissionCompletion } from './orcad-decommission-acceptance'

export function persistOrcadCompletedStopReceipt(
  request: OrcadManagedStopRequest,
  home: string
): void {
  const controlRoot = join(home, RELAY_REMOTE_DIR)
  const source = join(
    controlRoot,
    ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
    ORCAD_ACTIVATION_TRANSACTION_FILENAME
  )
  if (!lstatSync(source).isFile()) {
    throw new Error('orcad_completed_stop_transaction_unreadable')
  }
  const parsed = parseOrcadActivationTransaction(
    readNodeFileSyncWithinLimit(source, 64 * 1024).buffer.toString('utf8')
  )
  if (parsed.state !== 'ok' || parsed.transaction.operation !== 'decommission') {
    throw new Error('orcad_completed_stop_transaction_unreadable')
  }
  const completed = parseOrcadCompletedStopReceipt(
    serializeOrcadActivationTransaction(
      parsed.transaction.phase === 'process-exited'
        ? parsed.transaction
        : withOrcadDecommissionPhase(parsed.transaction, 'process-exited', new Date())
    )
  )
  if (completed.state !== 'ok') {
    throw new Error('orcad_completed_stop_receipt_unverifiable')
  }
  validateOrcadDecommissionCompletion(
    request.authority,
    request.version,
    home,
    request.instance,
    serializeOrcadActivationTransaction(parsed.transaction)
  )
  // Flush even an existing receipt: readable bytes do not prove a prior fsync completed.
  if (
    !writeDurableSecureJsonFile(
      join(controlRoot, ORCAD_COMPLETED_STOP_RECEIPT_FILENAME),
      completed.transaction
    )
  ) {
    throw new Error('orcad_completed_stop_receipt_permissions_unconfirmed')
  }
}
