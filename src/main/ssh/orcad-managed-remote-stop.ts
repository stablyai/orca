import { randomUUID } from 'node:crypto'
import {
  withDeactivatedVersion,
  withDecommissioningVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import {
  readOrcadActivationTransaction,
  writeOrcadActivationTransaction
} from './orcad-activation-transaction-store'
import {
  createOrcadDecommissionTransaction,
  sameOrcadActivationRecord,
  withOrcadDecommissionPhase,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import {
  OrcadManagedDecommissionResultSchema,
  OrcadManagedStopIdentitySchema
} from '../../shared/orcad-managed-decommission'
import { sameOrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import {
  managedStopOrcadCommand,
  parseManagedStopOrcadCompletion
} from './orcad-managed-stop-process-command'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteStopOptions, OrcadRemoteStopResult } from './orcad-remote-stop'
import {
  readRemoteOrcadCompletedStopReceipt,
  sameOrcadCompletedStopReceipt,
  sameExactOrcadStopTransaction
} from './orcad-completed-stop-receipt-store'
import { recoverManagedOrcadDecommission } from './orcad-managed-decommission-recovery'

export async function stopManagedRemoteOrcad(
  options: RemoteStopOptions,
  record: OrcadActivationRecord,
  lock: { retain(): void; retainOnError(): void }
): Promise<OrcadRemoteStopResult> {
  let preserveTransaction = false
  const preserve = (): void => {
    preserveTransaction = true
    lock.retainOnError()
  }
  const refuse = (
    reason: string,
    verdict: 'live' | 'unverifiable' = 'unverifiable'
  ): OrcadRemoteStopResult => {
    if (preserveTransaction) {
      lock.retain()
    }
    return { outcome: 'refused', verdict, code: 'orcad_managed_stop_unverifiable', reason }
  }
  const adapter = options.managedStop!
  const pinnedRuntimeId = adapter.runtimeId
  if (!pinnedRuntimeId.trim()) {
    return refuse('Managed stop requires a pinned runtime identity.')
  }
  let pending: Awaited<ReturnType<typeof readOrcadActivationTransaction>>
  try {
    pending = await readOrcadActivationTransaction(options)
  } catch (error) {
    preserve()
    return refuse(
      `The pending managed transaction cannot be verified: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (pending) {
    preserve()
  }
  if (!record.active) {
    const receipt = await readRemoteOrcadCompletedStopReceipt(options)
    if (
      !receipt ||
      receipt.authority?.runtimeId !== pinnedRuntimeId ||
      !sameOrcadActivationRecord(record, receipt.recordAfter)
    ) {
      return refuse('The deactivated server has no exact completed-stop receipt for this runtime.')
    }
    if (
      pending &&
      (pending.operation !== 'decommission' || !sameOrcadCompletedStopReceipt(receipt, pending))
    ) {
      return refuse('A different pending transaction prevents completed-stop recovery.')
    }
    preserve()
    await writeOrcadActivationTransaction(options, receipt)
    const recovered = await recoverManagedOrcadDecommission(options, receipt, record, lock)
    if (recovered.outcome !== 'recovered') {
      lock.retain()
      return recovered.outcome === 'refused'
        ? recovered
        : refuse('The completed-stop recovery did not prove exit.')
    }
    return { outcome: 'stopped', activeVersion: receipt.activeVersion, alreadyDeactivated: true }
  }
  if (pending) {
    return refuse('An existing managed transaction must be recovered before a new stop.')
  }
  if (record.decommissioning) {
    preserve()
    return refuse(
      'Managed stop requires an active slot without an earlier stop marker; resume its exact transaction through recovery.'
    )
  }
  record = structuredClone(record)
  const activeVersion = record.active!
  const observed = await adapter.readIdentity(activeVersion)
  if (observed.outcome === 'refused') {
    return observed
  }
  const verified = OrcadManagedStopIdentitySchema.safeParse(observed)
  if (
    !verified.success ||
    verified.data.version !== activeVersion ||
    !verified.data.instance ||
    verified.data.identity.runtimeId !== pinnedRuntimeId ||
    verified.data.completedStopReceipt !== 1
  ) {
    return refuse('The host did not provide the exact managed runtime instance for this version.')
  }
  const now = options.now ?? (() => new Date())
  const transactionId = randomUUID()
  const authority = Object.freeze({ ...verified.data.identity, transactionId })
  const acceptedRecord = withDecommissioningVersion(record, now())
  let transaction = createOrcadDecommissionTransaction({
    transactionId,
    authority,
    instance: verified.data.instance,
    activeVersion,
    recordBefore: record,
    acceptedRecord,
    recordAfter: withDeactivatedVersion(acceptedRecord),
    now: now()
  })
  preserve()
  await writeOrcadActivationTransaction(options, transaction)
  options.assertDecommissionAllowed?.()
  const response = OrcadManagedDecommissionResultSchema.safeParse(
    await adapter.requestDecommission(activeVersion, authority)
  )
  if (!response.success) {
    return refuse('The host returned an invalid managed-stop receipt.')
  }
  if (response.data.outcome === 'refused') {
    lock.retain()
    return response.data
  }
  if (
    response.data.transactionId !== transactionId ||
    !sameOrcadManagedStopAuthority(response.data.authority, authority)
  ) {
    return refuse('The host acknowledged a different managed-stop authority.')
  }
  if (!(await exactManagedStopCheckpoint(options, transaction))) {
    return refuse('The durable managed-stop transaction or acceptance receipt changed.')
  }
  transaction = withOrcadDecommissionPhase(transaction, 'admission-fenced', now())
  await writeOrcadActivationTransaction(options, transaction)
  const request = {
    schemaVersion: 1 as const,
    version: activeVersion,
    authority,
    instance: transaction.instance!
  }
  const remoteInstallDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    activeVersion,
    options.host.pathFlavor
  )
  options.assertDecommissionAllowed?.()
  const verdict = parseManagedStopOrcadCompletion(
    await execCommand(
      options.conn,
      managedStopOrcadCommand(options.host, remoteInstallDir, request, options.remoteHome),
      { wrapCommand: options.host.commandDialect !== 'powershell', signal: options.signal }
    ),
    request
  )
  if (verdict !== 'exited') {
    return refuse('The original managed runtime process has not been proved exited.', verdict)
  }
  const archived = await readRemoteOrcadCompletedStopReceipt(options)
  if (!archived || !sameOrcadCompletedStopReceipt(archived, transaction)) {
    return refuse('The host has not durably archived this exact completed stop.')
  }
  if (!(await exactManagedStopCheckpoint(options, transaction))) {
    return refuse(
      'The durable managed-stop transaction or acceptance receipt changed during completion.'
    )
  }
  transaction = withOrcadDecommissionPhase(transaction, 'process-exited', now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return { outcome: 'stopped', activeVersion, alreadyDeactivated: false }
}

async function exactManagedStopCheckpoint(
  options: RemoteStopOptions,
  transaction: OrcadDecommissionTransaction
): Promise<boolean> {
  const current = await readOrcadActivationTransaction(options)
  if (!current || !sameExactOrcadStopTransaction(current, transaction)) {
    return false
  }
  return sameOrcadActivationRecord(
    await readOrcadActivationRecord(options),
    transaction.acceptedRecord
  )
}
