/**
 * The decommission entry of the activation journal: stop the active orcad with an
 * instance-bound request and record that nothing serves, or put it back.
 *
 * Phases: `prepared` (nothing sent), `stop-dispatched` (the request may have reached the
 * host), `process-exited` (exit proven by a completed-stop receipt). Only the last may commit.
 * On the host the later two are filed under `dispatched`; see `orcadDecommissionJournal`.
 */
import {
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './orcad-activation-transaction-schema'
import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'

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

/** A dispatched stop as journaled: the real phase, under a field released desktops drop. */
export type OrcadDecommissionDispatch = {
  phase: 'stop-dispatched' | 'process-exited'
  request: OrcadManagedStopRequest
}

export type OrcadDecommissionJournal = Omit<OrcadDecommissionTransaction, 'phase' | 'request'> & {
  phase: 'prepared'
  request: null
  dispatched?: OrcadDecommissionDispatch
}

export type OrcadDecommissionRecoveryPlan =
  /** Exit was proven; write the deactivated record (if it is not there yet) and confirm. */
  | { action: 'confirm-decommissioned'; version: string; record: OrcadActivationRecord | null }
  /** The request may have reached orcad; its completion or cancellation decides. */
  | { action: 'resume-stop'; request: OrcadManagedStopRequest; record: OrcadActivationRecord }
  /** Nothing was sent; the active version must still be serving. */
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

/**
 * The entry as written to the host. Why a dispatched stop still reads `prepared` at the top level:
 * a released desktop recovering `stop-dispatched` or `process-exited` commits its core recordAfter,
 * which drops the stopped build's activeAppVersion, and its next connect then deploys its own older
 * build over state the stopped one may have migrated. Reading `prepared`, it relaunches the recorded
 * build instead. Released readers drop the unknown `dispatched` field.
 */
export function orcadDecommissionJournal(
  transaction: OrcadDecommissionTransaction
): OrcadDecommissionJournal {
  const { phase, request, ...rest } = transaction
  return phase === 'prepared' || !request
    ? { ...rest, phase: 'prepared', request: null }
    : { ...rest, phase: 'prepared', request: null, dispatched: { phase, request } }
}

/** A reason when the parsed journal is not a coherent decommission; otherwise `null`. */
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

/** Called once the current record matched one side of the transaction. */
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

/** The record a finished stop writes: the journaled `recordAfter` plus its advisory fields. */
export function committedOrcadDecommissionRecord(
  transaction: OrcadDecommissionTransaction
): OrcadActivationRecord {
  return withDeactivatedVersionCommitted(transaction.recordBefore)
}
