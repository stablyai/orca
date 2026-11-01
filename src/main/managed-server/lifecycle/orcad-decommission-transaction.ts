// Only process-exited may commit; dispatched phases nest under prepared for released readers.
import {
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type OrcadActivationRecord
} from '../activation/orcad-activation-record'
import { ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from '../activation/orcad-activation-transaction-schema'
import type { OrcadManagedStopRequest } from '../../../shared/orcad-stop-request'

export type OrcadDecommissionTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'decommission'
  phase: 'prepared' | 'stop-dispatched' | 'process-exited'
  startedAt: string
  updatedAt: string
  activeVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  request: OrcadManagedStopRequest | null
}

/** Released desktops drop this field. */
type OrcadDecommissionDispatch = {
  phase: 'stop-dispatched' | 'process-exited'
  request: OrcadManagedStopRequest
}

type OrcadDecommissionJournal = Omit<OrcadDecommissionTransaction, 'phase' | 'request'> & {
  phase: 'prepared'
  request: null
  dispatched?: OrcadDecommissionDispatch
}

export type OrcadDecommissionRecoveryPlan =
  | { action: 'confirm-decommissioned'; version: string; record: OrcadActivationRecord | null }
  /** Completion or cancellation must settle a possibly delivered request. */
  | { action: 'resume-stop'; request: OrcadManagedStopRequest; record: OrcadActivationRecord }
  | { action: 'keep-serving'; version: string }

export function createOrcadDecommissionTransaction(options: {
  transactionId: string
  recordBefore: OrcadActivationRecord & { active: string }
  now: Date
}): OrcadDecommissionTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'decommission',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    activeVersion: options.recordBefore.active,
    recordBefore: options.recordBefore,
    recordAfter: withDeactivatedVersion(options.recordBefore),
    request: null
  }
}

export function withOrcadDecommissionStopDispatched(
  transaction: OrcadDecommissionTransaction,
  request: OrcadManagedStopRequest,
  now: Date
): OrcadDecommissionTransaction {
  return { ...transaction, phase: 'stop-dispatched', updatedAt: now.toISOString(), request }
}

export function withOrcadDecommissionProcessExited(
  transaction: OrcadDecommissionTransaction,
  now: Date
): OrcadDecommissionTransaction {
  return { ...transaction, phase: 'process-exited', updatedAt: now.toISOString() }
}

/** Keep top-level prepared so released readers relaunch the recorded build instead of downgrading.
 * Their parser drops dispatched; their completed-stop path loses activeAppVersion protection. */
export function orcadDecommissionJournal(
  transaction: OrcadDecommissionTransaction
): OrcadDecommissionJournal {
  const { phase, request, ...rest } = transaction
  return phase === 'prepared' || !request
    ? { ...rest, phase: 'prepared', request: null }
    : { ...rest, phase: 'prepared', request: null, dispatched: { phase, request } }
}

export function orcadDecommissionTransactionDefect(
  transaction: OrcadDecommissionTransaction
): string | null {
  if (transaction.recordBefore.active !== transaction.activeVersion) {
    return 'decommission version does not match recordBefore'
  }
  if (
    serializeOrcadActivationRecord(transaction.recordAfter) !==
    serializeOrcadActivationRecord(withDeactivatedVersion(transaction.recordBefore))
  ) {
    return 'recordAfter is not the deactivated recordBefore'
  }
  if (transaction.request && transaction.request.version !== transaction.activeVersion) {
    return 'stop request names another version'
  }
  return null
}

export function planOrcadDecommissionRecovery(
  transaction: OrcadDecommissionTransaction,
  committed: boolean
): OrcadDecommissionRecoveryPlan {
  if (committed) {
    return { action: 'confirm-decommissioned', version: transaction.activeVersion, record: null }
  }
  if (transaction.phase === 'process-exited') {
    return {
      action: 'confirm-decommissioned',
      version: transaction.activeVersion,
      record: committedOrcadDecommissionRecord(transaction)
    }
  }
  if (transaction.phase === 'stop-dispatched' && transaction.request) {
    return {
      action: 'resume-stop',
      request: transaction.request,
      record: committedOrcadDecommissionRecord(transaction)
    }
  }
  return { action: 'keep-serving', version: transaction.activeVersion }
}

/** Preserve advisory fields alongside the journaled recordAfter. */
export function committedOrcadDecommissionRecord(
  transaction: OrcadDecommissionTransaction
): OrcadActivationRecord {
  return withDeactivatedVersionCommitted(transaction.recordBefore)
}
