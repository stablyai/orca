import {
  OrcadManagedStopAuthoritySchema,
  type OrcadManagedStopAuthority
} from '../../shared/orcad-managed-stop-authority'
import type { OrcadActivationRecord, OrcadStateSnapshot } from './orcad-activation-record'
import {
  OrcadManagedStopInstanceSchema,
  type OrcadManagedStopInstance
} from '../../shared/orcad-managed-stop-instance'
import { ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './orcad-activation-transaction-schema'
import type {
  OrcadActivateTransaction,
  OrcadRollbackTransaction,
  OrcadDecommissionTransaction
} from './orcad-activation-transaction'

export function createOrcadActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
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
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
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

export function createOrcadDecommissionTransaction(options: {
  transactionId: string
  authority?: OrcadManagedStopAuthority
  instance?: OrcadManagedStopInstance
  activeVersion: string
  recordBefore: OrcadActivationRecord
  acceptedRecord: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  now: Date
}): OrcadDecommissionTransaction {
  const timestamp = options.now.toISOString()
  const authority = options.authority
    ? OrcadManagedStopAuthoritySchema.parse(options.authority)
    : undefined
  const instance =
    options.instance === undefined
      ? undefined
      : OrcadManagedStopInstanceSchema.parse(options.instance)
  if (instance && !authority) {
    throw new Error('Managed stop instance requires authority')
  }
  if (authority && authority.transactionId !== options.transactionId) {
    throw new Error('Managed stop authority transaction ID mismatch')
  }
  if (authority && options.recordBefore.decommissioning) {
    throw new Error('Managed stop authority cannot adopt an earlier decommission marker')
  }
  return {
    schemaVersion: authority ? 2 : ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    ...(authority ? { authority } : {}),
    ...(instance ? { instance } : {}),
    transactionId: options.transactionId,
    operation: 'decommission',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    activeVersion: options.activeVersion,
    recordBefore: options.recordBefore,
    acceptedRecord: options.acceptedRecord,
    recordAfter: options.recordAfter
  }
}

export function withOrcadDecommissionPhase(
  transaction: OrcadDecommissionTransaction,
  phase: 'admission-fenced' | 'process-exited',
  now: Date
): OrcadDecommissionTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadActivationTransactionPhase(
  transaction: OrcadActivateTransaction,
  phase: 'incumbent-stopped',
  now: Date
): OrcadActivateTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadActivationSnapshot(
  transaction: OrcadActivateTransaction,
  snapshot: OrcadStateSnapshot | null,
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: {
      dirName: transaction.snapshot.dirName,
      state: snapshot ? 'captured' : 'empty'
    }
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
