import { randomUUID } from 'node:crypto'
import { assertOrcadStopNotCanceled } from './orcad-canceled-stop-receipt'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ORCAD_ACTIVATION_FILENAME,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationRecord
} from '../ssh/orcad-activation-record'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  sameOrcadActivationRecord
} from '../ssh/orcad-activation-transaction'
import { RELAY_REMOTE_DIR } from '../ssh/relay-protocol'
import {
  OrcadManagedStopInstanceSchema,
  sameOrcadManagedStopInstance,
  type OrcadManagedStopInstance
} from '../../shared/orcad-managed-stop-instance'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'
import {
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority
} from '../../shared/orcad-managed-stop-authority'

const MAX_RECORD_BYTES = 64 * 1024

export function validateOrcadDecommissionCancellation(
  authority: OrcadManagedStopAuthority,
  expectedVersion: string,
  expectedInstance: OrcadManagedStopInstance,
  home = homedir()
): void {
  const transaction = readValidatedDecommissionTransaction(
    authority.transactionId,
    expectedVersion,
    home,
    undefined,
    authority,
    'cancellation'
  )
  const current = parseOrcadActivationRecord(readBoundedFile(transaction.activationPath))
  if (
    transaction.phase !== 'prepared' ||
    !transaction.instance ||
    !sameOrcadManagedStopInstance(
      transaction.instance,
      OrcadManagedStopInstanceSchema.parse(expectedInstance)
    ) ||
    current.state !== 'ok' ||
    !sameOrcadActivationRecord(current.record, transaction.recordBefore) ||
    current.record.decommissioning
  ) {
    throw new Error('orcad_managed_stop_cancellation_unverifiable')
  }
}

export function validateOrcadDecommissionCompletion(
  authority: OrcadManagedStopAuthority,
  expectedVersion: string,
  home = homedir(),
  expectedInstance?: OrcadManagedStopInstance,
  expectedTransactionSnapshot?: string
): 'accepted' | 'process-exited' {
  const { activationPath, acceptedRecord, instance, phase, recordAfter } =
    readValidatedDecommissionTransaction(
      authority.transactionId,
      expectedVersion,
      home,
      expectedTransactionSnapshot,
      authority,
      'completion'
    )
  if (phase === 'process-exited' && !expectedInstance) {
    throw new Error('Completed managed stop requires the original instance identity.')
  }
  if (expectedInstance !== undefined) {
    const expected = OrcadManagedStopInstanceSchema.parse(expectedInstance)
    if (!instance || !sameOrcadManagedStopInstance(instance, expected)) {
      throw new Error('The managed stop transaction instance does not match this process.')
    }
  }
  const current = parseOrcadActivationRecord(readBoundedFile(activationPath))
  if (
    current.state !== 'ok' ||
    (!sameOrcadActivationRecord(current.record, acceptedRecord) &&
      !(phase === 'process-exited' && sameOrcadActivationRecord(current.record, recordAfter)))
  ) {
    throw new Error('The managed stop transaction has no durable acceptance receipt.')
  }
  new PtyOwnershipTransferAdmissionRecord(
    authority.profileRoot,
    authority.runtimeId
  ).assertClosedFor(authority)
  return phase === 'process-exited' ? 'process-exited' : 'accepted'
}

export function persistOrcadDecommissionAcceptance(
  transactionId: string,
  expectedVersion: string,
  home = homedir(),
  expectedTransactionSnapshot?: string,
  expectedAuthority?: OrcadManagedStopAuthority
): void {
  const { activationPath, acceptedRecord } = validateOrcadDecommissionTransaction(
    transactionId,
    expectedVersion,
    home,
    expectedTransactionSnapshot,
    expectedAuthority
  )
  // Readable acceptance does not prove that an earlier directory flush succeeded.
  writeDurableRecord(activationPath, serializeOrcadActivationRecord(acceptedRecord))
}

export function validateOrcadDecommissionTransaction(
  transactionId: string,
  expectedVersion: string,
  home = homedir(),
  expectedTransactionSnapshot?: string,
  expectedAuthority?: OrcadManagedStopAuthority
) {
  return readValidatedDecommissionTransaction(
    transactionId,
    expectedVersion,
    home,
    expectedTransactionSnapshot,
    expectedAuthority,
    'acceptance'
  )
}

function readValidatedDecommissionTransaction(
  transactionId: string,
  expectedVersion: string,
  home: string,
  expectedTransactionSnapshot: string | undefined,
  expectedAuthority: OrcadManagedStopAuthority | undefined,
  purpose: 'acceptance' | 'completion' | 'cancellation'
): {
  activationPath: string
  acceptedRecord: OrcadActivationRecord
  transactionSnapshot: string
  instance?: OrcadManagedStopInstance
  phase: 'prepared' | 'admission-fenced' | 'process-exited'
  recordAfter: OrcadActivationRecord
  recordBefore: OrcadActivationRecord
} {
  if (purpose !== 'cancellation') {
    assertOrcadStopNotCanceled(home, transactionId)
  }
  const controlRoot = join(home, RELAY_REMOTE_DIR)
  const transactionPath = join(
    controlRoot,
    ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
    ORCAD_ACTIVATION_TRANSACTION_FILENAME
  )
  const parsedTransaction = parseOrcadActivationTransaction(readBoundedFile(transactionPath))
  if (parsedTransaction.state !== 'ok') {
    throw new Error(
      `Cannot verify the managed stop transaction: ${
        parsedTransaction.state === 'absent' ? 'transaction is absent' : parsedTransaction.reason
      }`
    )
  }
  const transaction = parsedTransaction.transaction
  const transactionSnapshot = serializeOrcadActivationTransaction(transaction)
  if (
    expectedTransactionSnapshot !== undefined &&
    transactionSnapshot !== expectedTransactionSnapshot
  ) {
    throw new Error('The managed stop transaction changed during decommission acceptance.')
  }
  if (
    transaction.operation !== 'decommission' ||
    transaction.transactionId !== transactionId ||
    transaction.activeVersion !== expectedVersion
  ) {
    throw new Error('The managed stop transaction does not match this decommission request.')
  }
  if (transaction.phase === 'process-exited' && purpose === 'acceptance') {
    throw new Error('The managed stop transaction already records process exit.')
  }
  if (
    transaction.authority || expectedAuthority
      ? !transaction.authority ||
        !expectedAuthority ||
        !sameOrcadManagedStopAuthority(transaction.authority, expectedAuthority)
      : transaction.schemaVersion !== 1
  ) {
    throw new Error('The managed stop transaction authority does not match this runtime.')
  }
  if (
    transaction.recordBefore.active !== expectedVersion ||
    transaction.acceptedRecord.active !== expectedVersion ||
    transaction.acceptedRecord.decommissioning?.version !== expectedVersion
  ) {
    throw new Error('The managed stop transaction does not preserve the active runtime identity.')
  }

  const activationPath = join(controlRoot, ORCAD_ACTIVATION_FILENAME)
  const parsedRecord = parseOrcadActivationRecord(readBoundedFile(activationPath))
  if (parsedRecord.state !== 'ok') {
    throw new Error(
      `Cannot verify the managed activation record: ${
        parsedRecord.state === 'absent' ? 'record is absent' : parsedRecord.reason
      }`
    )
  }
  if (
    !sameOrcadActivationRecord(parsedRecord.record, transaction.acceptedRecord) &&
    !sameOrcadActivationRecord(parsedRecord.record, transaction.recordBefore) &&
    !(
      purpose === 'completion' &&
      transaction.phase === 'process-exited' &&
      sameOrcadActivationRecord(parsedRecord.record, transaction.recordAfter)
    )
  ) {
    throw new Error('The managed activation record changed during decommission acceptance.')
  }
  return {
    activationPath,
    acceptedRecord: transaction.acceptedRecord,
    transactionSnapshot,
    phase: transaction.phase,
    recordAfter: transaction.recordAfter,
    recordBefore: transaction.recordBefore,
    ...(transaction.instance ? { instance: transaction.instance } : {})
  }
}

function readBoundedFile(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) {
    throw new Error(`${path} is not a bounded regular file.`)
  }
  return readFileSync(path, 'utf8')
}

function writeDurableRecord(path: string, contents: string): void {
  const partialPath = `${path}.${process.pid}.${randomUUID()}.partial`
  try {
    writeFileSync(partialPath, contents, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(partialPath)
    renameSync(partialPath, path)
    if (process.platform !== 'win32') {
      try {
        fsyncFile(dirname(path))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
          throw error
        }
      }
    }
  } finally {
    rmSync(partialPath, { force: true })
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
