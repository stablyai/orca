/**
 * The host-side journal that makes an orcad activation, rollback or decommission crash-safe.
 *
 * Written before the first mutation and kept until the host is proven to serve exactly one
 * slot again. The activation record stays the commit point: a journal whose `recordAfter`
 * matches the record committed; one whose `recordBefore` matches did not, and recovery puts
 * the pre-transaction slot and state back. Anything else keeps the fence for an operator.
 */
import {
  parseOrcadActivationRecord,
  coreOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationRecord
} from './orcad-activation-record'
import {
  type ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
  OrcadActivationTransactionSchema
} from './orcad-activation-transaction-schema'
import {
  orcadDecommissionJournal,
  orcadDecommissionTransactionDefect,
  planOrcadDecommissionRecovery,
  type OrcadDecommissionRecoveryPlan,
  type OrcadDecommissionTransaction
} from './orcad-decommission-transaction'
import { errorMessage } from '../../shared/error-message'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export const ORCAD_ACTIVATION_TRANSACTION_FILENAME = 'transaction.json'
export const ORCAD_ACTIVATION_TRANSACTION_DIRNAME = '.orcad-activation-transaction'

export function orcadActivationTransactionRoot(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
}

export function orcadActivationFenceLockDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(
    host,
    orcadActivationTransactionRoot(host, remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
}

export function orcadActivationTransactionPath(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(
    host,
    orcadActivationTransactionRoot(host, remoteHome),
    ORCAD_ACTIVATION_TRANSACTION_FILENAME
  )
}

export type OrcadSnapshotVerdict = {
  dirName: string
  state: 'pending' | 'captured' | 'empty'
}

export type OrcadActivateTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'activate'
  phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
  startedAt: string
  updatedAt: string
  candidateVersion: string
  /** The app that started this activation, which a resumed commit stamps as activeAppVersion. */
  candidateAppVersion?: string | null
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord | null
  snapshot: OrcadSnapshotVerdict
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
  rescue: OrcadSnapshotVerdict
}

export type OrcadActivationTransaction =
  | OrcadActivateTransaction
  | OrcadRollbackTransaction
  | OrcadDecommissionTransaction

export type OrcadActivationTransactionReadResult =
  | { state: 'absent' }
  | { state: 'ok'; transaction: OrcadActivationTransaction }
  | { state: 'unreadable'; reason: string }

/** What recovery must do; `undo` lists the state to put back once the new slot is quiescent. */
export type OrcadTransactionRecoveryPlan =
  | { action: 'stabilize-committed'; activeVersion: string | null }
  /** The new slot passed its gate and the journal holds the record; only the write was lost. */
  | { action: 'finish-commit'; record: OrcadActivationRecord }
  | {
      action: 'undo'
      /** The slot that may have run after the state changed hands. */
      launchedVersion: string | null
      activeVersion: string | null
      restoreState: OrcadSnapshotVerdict | null
      launchedFromState?: OrcadSnapshotVerdict | null
    }
  | OrcadDecommissionRecoveryPlan
  | { action: 'refuse'; code: string; reason: string }

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
  if (parsed.data.operation === 'decommission') {
    const after = parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
    if (after.state === 'unreadable') {
      return after
    }
    const { dispatched, ...journal } = parsed.data
    const transaction = {
      ...journal,
      ...dispatched,
      recordBefore: recordBefore.record,
      recordAfter: after.record
    }
    const defect = orcadDecommissionTransactionDefect(transaction)
    return defect ? unreadable(defect) : { state: 'ok', transaction }
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
  if (
    recordBefore.record.active !== parsed.data.incumbentVersion ||
    recordBefore.record.previous !== parsed.data.targetVersion
  ) {
    return unreadable('rollback versions do not match recordBefore')
  }
  if (
    recordAfter.record.active !== parsed.data.targetVersion ||
    recordAfter.record.previous !== null ||
    recordAfter.record.snapshot !== null
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

export function serializeOrcadActivationTransaction(
  transaction: OrcadActivationTransaction & { fenceToken?: string }
): string {
  // The decommission form keeps any fenceToken: it spreads the rest of the entry.
  const journal =
    transaction.operation === 'decommission' ? orcadDecommissionJournal(transaction) : transaction
  return `${JSON.stringify(journal, null, 2)}\n`
}

export function planOrcadTransactionRecovery(
  transaction: OrcadActivationTransaction,
  currentRecord: OrcadActivationRecord
): OrcadTransactionRecoveryPlan {
  if (transaction.operation === 'decommission') {
    const committed = sameOrcadActivationRecord(currentRecord, transaction.recordAfter)
    return committed || sameOrcadActivationRecord(currentRecord, transaction.recordBefore)
      ? planOrcadDecommissionRecovery(transaction, committed)
      : recordChangedRefusal(transaction)
  }
  if (
    transaction.recordAfter &&
    sameOrcadActivationRecord(currentRecord, transaction.recordAfter)
  ) {
    return {
      action: 'stabilize-committed',
      activeVersion: transaction.recordAfter.active
    }
  }
  if (!sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    return recordChangedRefusal(transaction)
  }
  if (transaction.phase === 'candidate-ready' || transaction.phase === 'target-ready') {
    return {
      action: 'finish-commit',
      record: transaction.recordAfter ?? neverRecord()
    }
  }
  if (transaction.operation === 'activate') {
    // The candidate launches only after the snapshot verdict is durable.
    const launched = transaction.phase === 'snapshot-captured'
    return {
      action: 'undo',
      launchedVersion: launched ? transaction.candidateVersion : null,
      activeVersion: transaction.recordBefore.active,
      restoreState: launched ? transaction.snapshot : null
    }
  }
  // The rescue is the incumbent's state; it only needs restoring once the target's replaced it.
  const replaced = transaction.phase === 'rollback-state-restored'
  const rescued = replaced || transaction.phase === 'rescue-captured'
  return {
    action: 'undo',
    launchedVersion: replaced ? transaction.targetVersion : null,
    activeVersion: transaction.incumbentVersion,
    // A crash mid-restore leaves the phase at rescue-captured with the root half replaced.
    restoreState: rescued ? transaction.rescue : null,
    launchedFromState: replaced ? rollbackStartingState(transaction) : null
  }
}

/** The pre-activation snapshot a rollback restored before launching its target. */
export function rollbackStartingState(
  transaction: Pick<OrcadRollbackTransaction, 'recordBefore'>
): OrcadSnapshotVerdict | null {
  const snapshot = transaction.recordBefore.snapshot
  return snapshot ? { dirName: snapshot.dirName, state: 'captured' } : null
}

export function sameOrcadActivationRecord(
  left: OrcadActivationRecord,
  right: OrcadActivationRecord
): boolean {
  return (
    serializeOrcadActivationRecord(coreOrcadActivationRecord(left)) ===
    serializeOrcadActivationRecord(coreOrcadActivationRecord(right))
  )
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

function recordChangedRefusal(
  transaction: OrcadActivationTransaction
): Extract<OrcadTransactionRecoveryPlan, { action: 'refuse' }> {
  return {
    action: 'refuse',
    code: 'orcad_recovery_activation_record_changed',
    reason:
      `The activation record matches neither side of the interrupted ${transaction.operation}. ` +
      'Preserving the activation fence for operator inspection.'
  }
}

function neverRecord(): never {
  throw new Error('A committed phase must carry its record; the schema enforces this.')
}

function unreadable(reason: string): { state: 'unreadable'; reason: string } {
  return { state: 'unreadable', reason }
}
