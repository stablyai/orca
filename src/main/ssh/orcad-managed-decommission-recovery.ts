import type {
  OrcadActivationRecoveryOptions,
  OrcadActivationRecoveryResult
} from './orcad-activation-recovery'
import type { OrcadActivationRecord } from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import {
  readOrcadActivationTransaction,
  writeOrcadActivationTransaction
} from './orcad-activation-transaction-store'
import {
  sameOrcadActivationRecord,
  withOrcadDecommissionPhase,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import { OrcadManagedDecommissionResultSchema } from '../../shared/orcad-managed-decommission'
import { sameOrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import { OrcadManagedStopRequestSchema } from '../../shared/orcad-managed-stop-request'
import {
  managedStopOrcadCommand,
  parseManagedStopOrcadCompletion
} from './orcad-managed-stop-process-command'
import { execCommand } from './ssh-relay-deploy-helpers'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import {
  readRemoteOrcadCompletedStopReceipt,
  sameOrcadCompletedStopReceipt,
  sameExactOrcadStopTransaction
} from './orcad-completed-stop-receipt-store'

type ManagedRecoveryOptions = Pick<
  OrcadActivationRecoveryOptions,
  | 'conn'
  | 'host'
  | 'remoteHome'
  | 'signal'
  | 'requestManagedDecommission'
  | 'assertDecommissionAllowed'
>

export async function recoverManagedOrcadDecommission(
  options: ManagedRecoveryOptions,
  original: OrcadDecommissionTransaction,
  observedRecord: OrcadActivationRecord,
  lock: { retain(): void }
): Promise<OrcadActivationRecoveryResult> {
  const refuse = (
    reason: string,
    verdict: 'live' | 'unverifiable' = 'unverifiable'
  ): OrcadActivationRecoveryResult => {
    lock.retain()
    return {
      outcome: 'refused',
      verdict,
      code: 'orcad_recovery_decommission_authority_unavailable',
      reason
    }
  }
  if (original.schemaVersion !== 2 || !original.authority || !original.instance) {
    return refuse(
      'The interrupted managed stop does not retain its exact original process authority.'
    )
  }
  let transaction = structuredClone(original)
  let record = structuredClone(observedRecord)
  const parsedRequest = OrcadManagedStopRequestSchema.safeParse({
    schemaVersion: 1,
    version: transaction.activeVersion,
    authority: transaction.authority,
    instance: transaction.instance
  })
  if (!parsedRequest.success) {
    return refuse('The interrupted managed stop has invalid original process authority.')
  }
  const request = parsedRequest.data
  try {
    if (!(await exactCheckpoint(options, transaction, record))) {
      return refuse('The managed-stop checkpoint changed before recovery.')
    }
    if (sameOrcadActivationRecord(record, transaction.recordBefore)) {
      if (transaction.phase !== 'prepared' || !options.requestManagedDecommission) {
        return refuse('The original managed-stop acceptance cannot be replayed safely.')
      }
      options.assertDecommissionAllowed?.()
      const response = OrcadManagedDecommissionResultSchema.safeParse(
        await options.requestManagedDecommission(
          transaction.activeVersion,
          Object.freeze({ ...request.authority })
        )
      )
      if (!response.success) {
        return refuse('The host returned an invalid managed-stop receipt.')
      }
      if (response.data.outcome === 'refused') {
        lock.retain()
        return response.data
      }
      if (
        response.data.transactionId !== transaction.transactionId ||
        !sameOrcadManagedStopAuthority(response.data.authority, request.authority)
      ) {
        return refuse('The host acknowledged a different managed-stop authority.')
      }
      record = transaction.acceptedRecord
      if (!(await exactCheckpoint(options, transaction, record))) {
        return refuse('The host did not durably accept the exact managed-stop transaction.')
      }
    } else if (
      !sameOrcadActivationRecord(record, transaction.acceptedRecord) &&
      !(
        transaction.phase === 'process-exited' &&
        sameOrcadActivationRecord(record, transaction.recordAfter)
      )
    ) {
      return refuse('The activation record is not an exact side of this managed stop.')
    }
    if (transaction.phase === 'prepared') {
      transaction = withOrcadDecommissionPhase(transaction, 'admission-fenced', new Date())
      await writeOrcadActivationTransaction(options, transaction)
    }
    if (!(await exactCheckpoint(options, transaction, record))) {
      return refuse('The managed-stop checkpoint changed before process observation.')
    }
    options.assertDecommissionAllowed?.()
    const verdict = parseManagedStopOrcadCompletion(
      await execCommand(
        options.conn,
        managedStopOrcadCommand(
          options.host,
          computeRemoteInstallDir(
            ORCAD_INSTALL_MODEL,
            options.remoteHome,
            transaction.activeVersion,
            options.host.pathFlavor
          ),
          request,
          options.remoteHome
        ),
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
    if (!(await exactCheckpoint(options, transaction, record))) {
      return refuse('The managed-stop checkpoint changed during process observation.')
    }
    if (transaction.phase !== 'process-exited') {
      transaction = withOrcadDecommissionPhase(transaction, 'process-exited', new Date())
      await writeOrcadActivationTransaction(options, transaction)
      if (!(await exactCheckpoint(options, transaction, record))) {
        return refuse('The managed-stop checkpoint changed while recording process exit.')
      }
    }
    if (!sameOrcadActivationRecord(record, transaction.recordAfter)) {
      await writeOrcadActivationRecord(options, transaction.recordAfter)
    }
    return { outcome: 'recovered', resolution: 'committed', activeVersion: null, readiness: null }
  } catch (error) {
    return refuse(
      `The managed-stop recovery remains unverifiable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function exactCheckpoint(
  options: ManagedRecoveryOptions,
  transaction: OrcadDecommissionTransaction,
  record: OrcadActivationRecord
): Promise<boolean> {
  const current = await readOrcadActivationTransaction(options)
  return (
    !!current &&
    sameExactOrcadStopTransaction(current, transaction) &&
    sameOrcadActivationRecord(await readOrcadActivationRecord(options), record)
  )
}
