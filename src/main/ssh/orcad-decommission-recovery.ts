import type {
  OrcadActivationRecoveryOptions,
  OrcadActivationRecoveryResult
} from './orcad-activation-recovery'
import type { OrcadActivationRecord } from './orcad-activation-record'
import { recoverManagedOrcadDecommission } from './orcad-managed-decommission-recovery'
import {
  sameOrcadActivationRecord,
  withOrcadDecommissionPhase,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import {
  ensureRecordedRuntimeServing,
  orcadRecoveryInstallDir as installDir,
  executeOrcadRecoveryCommand as exec
} from './orcad-recovery-slot'

const STOP_WAIT_SECONDS = 20

export async function recoverInterruptedDecommission(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadDecommissionTransaction,
  currentRecord: OrcadActivationRecord,
  lock: { retain(): void }
): Promise<OrcadActivationRecoveryResult> {
  if (transaction.schemaVersion !== 1 || transaction.authority) {
    return recoverManagedOrcadDecommission(options, transaction, currentRecord, lock)
  }
  if (sameOrcadActivationRecord(currentRecord, transaction.recordAfter)) {
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    }
  }

  let accepted = sameOrcadActivationRecord(currentRecord, transaction.acceptedRecord)
  if (!accepted && !sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_decommission_record_changed',
      reason:
        'The activation record matches no durable side of the interrupted managed stop. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }

  if (!accepted) {
    if (!options.requestDecommission) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_rpc_unavailable',
        reason: 'The interrupted managed stop requires its paired runtime to resume safely.'
      }
    }
    options.assertDecommissionAllowed?.()
    const response = await options.requestDecommission(
      transaction.activeVersion,
      transaction.transactionId
    )
    if (response.outcome === 'refused') {
      if (response.verdict === 'unverifiable' || response.terminalAdmission !== 'open') {
        lock.retain()
        return response
      }
      const readiness = await ensureRecordedRuntimeServing(options, transaction.activeVersion)
      return {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: transaction.activeVersion,
        readiness
      }
    }
    if (response.transactionId && response.transactionId !== transaction.transactionId) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_receipt_mismatch',
        reason: 'The host acknowledged a different managed-stop transaction.'
      }
    }
    const afterRpc = await readOrcadActivationRecord(options)
    if (sameOrcadActivationRecord(afterRpc, transaction.recordBefore)) {
      await writeOrcadActivationRecord(options, transaction.acceptedRecord)
    } else if (!sameOrcadActivationRecord(afterRpc, transaction.acceptedRecord)) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_record_changed',
        reason: 'The activation record changed while resuming decommission acceptance.'
      }
    }
    accepted = true
  }

  if (!accepted) {
    throw new Error('Managed stop acceptance was not established.')
  }
  let resumed = withOrcadDecommissionPhase(transaction, 'admission-fenced', new Date())
  await writeOrcadActivationTransaction(options, resumed)
  const remoteDir = installDir(options, transaction.activeVersion)
  options.assertDecommissionAllowed?.()
  const stopped = parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, remoteDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
  if (!orcadStopFreedTheHost(stopped)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: stopped === 'still-running' || stopped === 'signal-failed' ? 'live' : 'unverifiable',
      code:
        stopped === 'still-running' || stopped === 'signal-failed'
          ? 'orcad_recovery_stop_incomplete'
          : 'orcad_recovery_stop_unverifiable',
      reason:
        `The host could not complete the interrupted stop for orcad ` +
        `${transaction.activeVersion} (${stopped}). The managed server remains linked.`
    }
  }
  resumed = withOrcadDecommissionPhase(resumed, 'process-exited', new Date())
  await writeOrcadActivationTransaction(options, resumed)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'recovered',
    resolution: 'committed',
    activeVersion: null,
    readiness: null
  }
}
