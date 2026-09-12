import type { OrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import type { OrcadManagedStopInstance } from '../../shared/orcad-managed-stop-instance'
import {
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationRecord
} from './orcad-activation-record'
import {
  type ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
  OrcadActivationTransactionSchema
} from './orcad-activation-transaction-schema'
export { ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './orcad-activation-transaction-schema'

export const ORCAD_ACTIVATION_TRANSACTION_FILENAME = 'transaction.json'
export const ORCAD_ACTIVATION_TRANSACTION_DIRNAME = '.orcad-activation-transaction'

export type OrcadActivateTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'activate'
  phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
  startedAt: string
  updatedAt: string
  candidateVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord | null
  snapshot: { dirName: string; state: 'pending' | 'captured' | 'empty' }
}

export type OrcadRollbackTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'rollback'
  phase:
    | 'prepared'
    | 'incumbent-stopped'
    | 'rescue-captured'
    | 'rollback-state-restored'
    | 'target-ready'
  startedAt: string
  updatedAt: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  rescue: { dirName: string; state: 'pending' | 'captured' | 'empty' }
}

export type OrcadDecommissionTransaction = {
  schemaVersion: 1 | 2
  authority?: OrcadManagedStopAuthority
  instance?: OrcadManagedStopInstance
  transactionId: string
  operation: 'decommission'
  phase: 'prepared' | 'admission-fenced' | 'process-exited'
  startedAt: string
  updatedAt: string
  activeVersion: string
  recordBefore: OrcadActivationRecord
  acceptedRecord: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
}

export type OrcadActivationTransaction =
  | OrcadActivateTransaction
  | OrcadRollbackTransaction
  | OrcadDecommissionTransaction

export type OrcadActivationTransactionReadResult =
  | { state: 'absent' }
  | { state: 'ok'; transaction: OrcadActivationTransaction }
  | { state: 'unreadable'; reason: string }

export type OrcadActivationRecoveryPlan =
  | {
      action: 'stabilize-committed'
      record: OrcadActivationRecord
    }
  | {
      action: 'restore-record-before'
      record: OrcadActivationRecord
      candidateVersion: string
      restoreSnapshot: boolean
      snapshot: OrcadActivateTransaction['snapshot']
    }
  | { action: 'refuse'; code: string; reason: string }

export {
  createOrcadActivationTransaction,
  createOrcadRollbackTransaction,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue,
  createOrcadDecommissionTransaction,
  withOrcadDecommissionPhase,
  withOrcadActivationTransactionPhase,
  withOrcadActivationSnapshot,
  withOrcadActivationCandidateReady
} from './orcad-activation-transaction-transitions'

export function parseOrcadActivationTransaction(
  raw: string | null
): OrcadActivationTransactionReadResult {
  if (raw === null || raw.trim() === '') {
    return { state: 'absent' }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return unreadable(`transaction is not JSON: ${errorMessage(error)}`)
  }
  const parsed = OrcadActivationTransactionSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : 'transaction'
    return unreadable(`${path} is invalid: ${issue?.message ?? 'unknown shape'}`)
  }
  const recordBefore = parseNestedRecord(parsed.data.recordBefore, 'recordBefore')
  if (recordBefore.state === 'unreadable') {
    return recordBefore
  }
  if (parsed.data.operation === 'activate') {
    const recordAfter =
      parsed.data.recordAfter === null
        ? null
        : parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
    if (recordAfter?.state === 'unreadable') {
      return recordAfter
    }
    if (recordAfter && recordAfter.record.active !== parsed.data.candidateVersion) {
      return unreadable('recordAfter does not activate candidateVersion')
    }
    return {
      state: 'ok',
      transaction: {
        ...parsed.data,
        recordBefore: recordBefore.record,
        recordAfter: recordAfter?.record ?? null
      }
    }
  }
  const recordAfter = parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
  if (recordAfter.state === 'unreadable') {
    return recordAfter
  }
  if (parsed.data.operation === 'rollback') {
    if (
      recordBefore.record.active !== parsed.data.incumbentVersion ||
      recordBefore.record.previous !== parsed.data.targetVersion
    ) {
      return unreadable('rollback versions do not match recordBefore')
    }
    if (
      recordAfter.record.active !== parsed.data.targetVersion ||
      recordAfter.record.previous !== null ||
      recordAfter.record.snapshot !== null ||
      recordAfter.record.decommissioning
    ) {
      return unreadable('recordAfter is not a completed rollback record')
    }
    return {
      state: 'ok',
      transaction: {
        ...parsed.data,
        recordBefore: recordBefore.record,
        recordAfter: recordAfter.record
      }
    }
  }
  const acceptedRecord = parseNestedRecord(parsed.data.acceptedRecord, 'acceptedRecord')
  if (acceptedRecord.state === 'unreadable') {
    return acceptedRecord
  }
  if (parsed.data.schemaVersion === 2 && recordBefore.record.decommissioning) {
    return unreadable('Managed stop authority cannot adopt an earlier decommission marker')
  }
  if (
    recordBefore.record.active !== parsed.data.activeVersion ||
    acceptedRecord.record.active !== parsed.data.activeVersion ||
    acceptedRecord.record.decommissioning?.version !== parsed.data.activeVersion ||
    !sameOrcadActivationRecord(acceptedRecord.record, {
      ...recordBefore.record,
      decommissioning: acceptedRecord.record.decommissioning
    })
  ) {
    return unreadable('acceptedRecord is not the exact decommission transition')
  }
  if (
    recordAfter.record.active !== null ||
    recordAfter.record.previous !== parsed.data.activeVersion ||
    recordAfter.record.activatedAt !== null ||
    recordAfter.record.snapshot !== null ||
    recordAfter.record.decommissioning
  ) {
    return unreadable('recordAfter is not a completed decommission record')
  }
  return {
    state: 'ok',
    transaction: {
      ...parsed.data,
      recordBefore: recordBefore.record,
      acceptedRecord: acceptedRecord.record,
      recordAfter: recordAfter.record
    }
  }
}

export function serializeOrcadActivationTransaction(
  transaction: OrcadActivationTransaction
): string {
  return `${JSON.stringify(transaction, null, 2)}\n`
}

export function planOrcadActivationRecovery(
  transaction: OrcadActivateTransaction,
  currentRecord: OrcadActivationRecord
): OrcadActivationRecoveryPlan {
  if (
    transaction.recordAfter &&
    sameOrcadActivationRecord(currentRecord, transaction.recordAfter)
  ) {
    return { action: 'stabilize-committed', record: transaction.recordAfter }
  }
  if (!sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    return {
      action: 'refuse',
      code: 'orcad_recovery_activation_record_changed',
      reason:
        'The activation record matches neither side of the interrupted transaction. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }
  return {
    action: 'restore-record-before',
    record: transaction.recordBefore,
    candidateVersion: transaction.candidateVersion,
    restoreSnapshot:
      transaction.phase === 'snapshot-captured' || transaction.phase === 'candidate-ready',
    snapshot: transaction.snapshot
  }
}

function parseNestedRecord(
  value: unknown,
  field: string
): { state: 'ok'; record: OrcadActivationRecord } | { state: 'unreadable'; reason: string } {
  const parsed = parseOrcadActivationRecord(JSON.stringify(value))
  return parsed.state === 'ok'
    ? { state: 'ok', record: parsed.record }
    : unreadable(
        `${field} is invalid: ${parsed.state === 'absent' ? 'record is absent' : parsed.reason}`
      )
}

function unreadable(reason: string): { state: 'unreadable'; reason: string } {
  return { state: 'unreadable', reason }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sameOrcadActivationRecord(
  left: OrcadActivationRecord,
  right: OrcadActivationRecord
): boolean {
  return serializeOrcadActivationRecord(left) === serializeOrcadActivationRecord(right)
}
