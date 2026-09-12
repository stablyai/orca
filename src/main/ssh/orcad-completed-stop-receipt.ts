import {
  parseOrcadActivationTransaction,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import type { OrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import type { OrcadManagedStopInstance } from '../../shared/orcad-managed-stop-instance'

export const ORCAD_COMPLETED_STOP_RECEIPT_FILENAME = 'orcad-completed-stop.json'
export type OrcadCompletedStopReceipt = OrcadDecommissionTransaction & {
  schemaVersion: 2
  phase: 'process-exited'
  authority: OrcadManagedStopAuthority
  instance: OrcadManagedStopInstance
}

export function parseOrcadCompletedStopReceipt(
  raw: string | null
):
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'ok'; transaction: OrcadCompletedStopReceipt } {
  const parsed = parseOrcadActivationTransaction(raw)
  if (parsed.state !== 'ok') {
    return parsed
  }
  const transaction = parsed.transaction
  if (
    transaction.operation !== 'decommission' ||
    transaction.schemaVersion !== 2 ||
    transaction.phase !== 'process-exited' ||
    !transaction.authority ||
    !transaction.instance
  ) {
    return {
      state: 'unreadable',
      reason: 'Completed stop receipt lacks exact original process proof.'
    }
  }
  return {
    state: 'ok',
    transaction: {
      ...transaction,
      schemaVersion: 2,
      phase: 'process-exited',
      authority: transaction.authority,
      instance: transaction.instance
    }
  }
}
