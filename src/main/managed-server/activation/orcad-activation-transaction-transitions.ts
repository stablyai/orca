import type { OrcadActivationRecord } from './orcad-activation-record'
import { ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './orcad-activation-transaction-schema'
import type {
  OrcadActivateTransaction,
  OrcadRollbackTransaction
} from './orcad-activation-transaction'

export function createOrcadActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
  appVersion?: string
  recordBefore: OrcadActivationRecord
  snapshotDirName: string
  now: Date
}): OrcadActivateTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'activate',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    candidateVersion: options.candidateVersion,
    candidateAppVersion: options.appVersion ?? null,
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
  }
}

export function withOrcadActivationIncumbentStopped(
  transaction: OrcadActivateTransaction,
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'incumbent-stopped',
    updatedAt: now.toISOString()
  }
}

export function withOrcadActivationSnapshot(
  transaction: OrcadActivateTransaction,
  state: 'captured' | 'empty',
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: { dirName: transaction.snapshot.dirName, state }
  }
}

export function withOrcadActivationCandidateReady(
  transaction: OrcadActivateTransaction,
  recordAfter: OrcadActivationRecord,
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'candidate-ready',
    updatedAt: now.toISOString(),
    recordAfter
  }
}

export function createOrcadRollbackTransaction(options: {
  transactionId: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  rescueDirName: string
  now: Date
}): OrcadRollbackTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'rollback',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    incumbentVersion: options.incumbentVersion,
    targetVersion: options.targetVersion,
    recordBefore: options.recordBefore,
    recordAfter: options.recordAfter,
    rescue: { dirName: options.rescueDirName, state: 'pending' }
  }
}

export function withOrcadRollbackPhase(
  transaction: OrcadRollbackTransaction,
  phase: 'incumbent-stopped' | 'rollback-state-restored' | 'target-ready',
  now: Date
): OrcadRollbackTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadRollbackRescue(
  transaction: OrcadRollbackTransaction,
  state: 'captured' | 'empty',
  now: Date
): OrcadRollbackTransaction {
  return {
    ...transaction,
    phase: 'rescue-captured',
    updatedAt: now.toISOString(),
    rescue: { dirName: transaction.rescue.dirName, state }
  }
}
